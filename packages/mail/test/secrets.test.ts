/**
 * The mail filter, tested from both sides. Missing a one-time code is the
 * failure everyone has already had in production; redacting an invoice is
 * the failure that makes people turn the feature off. Both are here.
 */
import { describe, expect, it } from "vitest";
import { redactionNote, stripSecrets } from "../src/secrets.js";

const strip = (text: string) => stripSecrets(text);

describe("one-time codes", () => {
  it("takes the code out of the mail everyone actually gets", () => {
    for (const text of [
      "Your verification code is 483920. It expires in 10 minutes.",
      "Doğrulama kodunuz: 483920",
      "Giriş kodu 48 39 20 — kimseyle paylaşmayın.",
      "Use passcode 4839-20 to sign in.",
      "Tek kullanımlık şifreniz 483920'dir.",
      "Your one-time password: A4B9C2",
    ]) {
      const out = strip(text);
      expect(out.text, text).not.toMatch(/483920|4839|A4B9C2/);
      expect(out.removed).toContain("code");
    }
  });

  it("reads the login mail of every language Vunemi speaks", () => {
    for (const text of [
      "Ihr Bestätigungscode lautet 483920.",
      "Votre code de vérification : 483920",
      "Tu código de verificación es 483920.",
      "Il tuo codice di verifica è 483920.",
      "Seu código de verificação é 483920.",
      "Ваш код подтверждения: 483920",
      "您的验证码是483920，5分钟内有效。",
      "認証コード：483920",
      "인증번호 [483920]를 입력하세요.",
    ]) {
      const out = strip(text);
      expect(out.text, text).not.toContain("483920");
      expect(out.removed, text).toContain("code");
    }
  });

  it("catches the code when it stands on its own line, as most of them do", () => {
    const mail = "Hesabınıza giriş yapmak için aşağıdaki kodu kullanın:\n\n739104\n\nBu kodu kimseyle paylaşmayın.";
    const out = strip(mail);
    expect(out.text).not.toContain("739104");
    expect(out.removed).toEqual(["code"]);
  });

  it("leaves the numbers in an ordinary message alone", () => {
    for (const text of [
      "Faturanız 1.249,90 TL tutarındadır. Sipariş numarası 20260923.",
      "Toplantı 14:30'da, oda 412. Katılımcı sayısı 18.",
      "Your order #A1B2C3 has shipped. Tracking 1Z999AA10123456784.",
      "2026 yılı bütçesi 145000 olarak revize edildi.",
      "Uçuş TK1984, koltuk 23A, kapı B12.",
    ]) {
      const out = strip(text);
      expect(out.text, text).toBe(text);
      expect(out.removed, text).toEqual([]);
    }
  });

  // The first version of this filter turned this very mail into three
  // redaction markers: "kodu" sat near enough to everything in a short
  // message. Over-redaction is the failure that gets a feature switched off.
  it("leaves an invoice that happens to mention a product code intact", () => {
    const mail = "Faturanız 1.249,90 TL. Sipariş numarası 20260923. Ürün kodu: XR-4410.";
    const out = strip(mail);
    expect(out.text).toBe(mail);
    expect(out.removed).toEqual([]);
  });

  // The limit of a filter that cannot read: in a message that IS about
  // signing in, a code-shaped value next to the word "kod" is removed even
  // when a human would see it is a product code. Written down rather than
  // tuned away, because nothing in the text distinguishes the two — and
  // between showing a real one-time code and hiding a product code, hiding
  // is the error we can live with.
  it("errs towards removal when the message is about signing in", () => {
    const mail = "Giriş yaptığınız cihaz değişti. Sipariş ettiğiniz ürünün kodu: XR-4410.";
    expect(strip(mail).text).not.toContain("XR-4410");
  });

  it("does not redact a number just because the mail says the word once", () => {
    // "kod" appears, but far from the figure: an invoice, not a login.
    const mail = "Ürün kodu listesi ektedir.\n\n" + "Bu ayki toplam tutar 128450 TL olarak hesaplanmıştır.".padStart(400, " ");
    expect(strip(mail).text).toContain("128450");
  });
});

describe("sign-in links", () => {
  it("removes magic links and password resets", () => {
    for (const url of [
      "https://app.example.com/magic?token=abc123def456ghi789",
      "https://accounts.example.com/reset-password/9f3a7c21b8e4d6a50192837465",
      "https://example.com/verify?code=884213",
      "https://example.com/auth/callback?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123",
      "https://example.com/invitation/accept?invite=Zk91mQ72XbA4Lp08",
    ]) {
      const out = strip(`Giriş yapmak için tıklayın: ${url}`);
      expect(out.text, url).not.toContain(url);
      expect(out.removed, url).toContain("link");
    }
  });

  it("leaves ordinary links where the agent can still follow them", () => {
    for (const url of [
      "https://example.com/siparis/20260923",
      "https://news.ycombinator.com/item?id=12345678",
      "https://github.com/ocak/ocak/pull/42",
      "https://example.com/blog/2026/09/yeni-surum",
    ]) {
      const out = strip(`Ayrıntılar burada: ${url}`);
      expect(out.text, url).toContain(url);
      expect(out.removed, url).toEqual([]);
    }
  });

  it("takes the whole link rather than leaving half of one behind", () => {
    const out = strip("Şifrenizi sıfırlamak için https://example.com/reset-password?token=aaa111bbb222ccc adresine gidin.");
    expect(out.text).not.toContain("example.com");
    expect(out.text).toContain("adresine gidin");
  });
});

describe("what the model is told", () => {
  it("says something was removed, and who has to read it", () => {
    const note = redactionNote(["code"]);
    expect(note).toMatch(/code/i);
    expect(note).toMatch(/user/i);
    // It must not invite the agent to ask the user to read the code out.
    expect(note).toMatch(/do not ask them for the code/);
  });

  it("says nothing when nothing was removed", () => {
    expect(redactionNote([])).toBe("");
  });

  it("names both when both were taken", () => {
    expect(redactionNote(["code", "link"])).toMatch(/code.*link/s);
  });
});

describe("the attack this exists for", () => {
  it("survives the Comet shape: a page telling the agent to fetch the code", () => {
    // The mail the agent would read after following a planted instruction.
    const mail = [
      "From: security@bank.example",
      "Subject: Giriş doğrulama",
      "",
      "Hesabınıza giriş yapmak için doğrulama kodunuz: 902417",
      "Kod 5 dakika geçerlidir.",
      "Oturum açmak için: https://bank.example/signin?token=8f3b2a91c7d5e604",
    ].join("\n");

    const out = strip(mail);
    expect(out.text).not.toContain("902417");
    expect(out.text).not.toContain("8f3b2a91c7d5e604");
    expect(out.removed.sort()).toEqual(["code", "link"]);
    // The rest of the message still reads, so the agent can say what arrived.
    expect(out.text).toContain("security@bank.example");
    expect(out.text).toContain("Giriş doğrulama");
  });
});
