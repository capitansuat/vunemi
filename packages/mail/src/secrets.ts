/**
 * Takes the keys out of the mail before the model reads it.
 *
 * This is the countermeasure to the attack that has actually happened, more
 * than once: a page tells the agent to go and read the user's inbox, and the
 * agent obligingly repeats the one-time code or the sign-in link back into
 * the page. Brave demonstrated it against Comet in August 2025 and the shape
 * has not changed since. The agent never needs these values — a person
 * finishing a login types the code themselves — so the cheapest fix is for
 * the model never to be shown them at all.
 *
 * Two honest limits. First, this is a deterministic filter, which makes it
 * defence in depth and not a boundary: a code spelled out in words gets
 * through. Second, redaction is visible on purpose. A silent removal would
 * leave the model guessing why a sentence makes no sense; the marker says
 * what was taken and that the user has to read it themselves.
 *
 * It is tuned to under-redact rather than over-redact. An invoice full of
 * numbers has to survive this, or people stop using mail at all — so a value
 * is only taken when the message is about signing in AND the word "code" is
 * pointing at that value. Inside a message that really is about a login it
 * still errs the other way: a product code next to the word "kod" goes too,
 * because nothing in the text tells the two apart, and hiding a product code
 * is the cheaper mistake.
 */

/** What a removal leaves behind. The model reads it, so it is in English. */
const CODE_MARK = "«one-time code hidden — the user must read it in the message themselves»";
const LINK_MARK = "«sign-in link hidden — the user must open it from the message themselves»";

export type SecretKind = "code" | "link";

export interface Stripped {
  text: string;
  /** What kinds were taken out, for the note above the message. */
  removed: SecretKind[];
}

/**
 * Words that put a number in the company of a login, in every language Vunemi
 * speaks: a user who reads Vunemi in German gets their login codes in German.
 * Kept deliberately narrow: "kod" appears in ordinary mail, so it only counts
 * near a value that looks like a credential.
 */
const CODE_WORDS = new RegExp(
  [
    // English, Turkish
    "one[- ]?time|single[- ]?use|verification|verify|confirmation|confirm|security|access|login|log[- ]?in|sign[- ]?in|auth(?:entication)?|passcode|pass ?code|otp|2fa|two[- ]?factor|mfa|pin|temporary password",
    "tek kullanımlık|doğrulama|onay|güvenlik|giriş|oturum|kimlik doğrulama|geçici (?:şifre|parola)|tek seferlik",
    // German, French, Spanish, Italian, Portuguese
    "bestätigung|verifizierung|anmeld|einmal|sicherheit",
    "vérification|connexion|sécurité|usage unique",
    "verificación|inicio de sesión|seguridad|un solo uso",
    "verifica|sicurezza|monouso",
    "verificação|segurança|uso único",
    // Russian, Chinese, Japanese, Korean
    "подтвержд|вход|безопасност|одноразов",
    "验证|登录|登入|安全|一次性",
    "認証|確認|ログイン|ワンタイム|セキュリティ",
    "인증|확인|로그인|보안|일회용",
  ].join("|"),
  "i",
);

/** The word for the thing itself, so "your code is" is caught either way. */
const CODE_NOUN = new RegExp(
  [
    "code|c[oó]digo|codice|kod(?:u|unuz)?|şifre(?:niz)?|parola(?:nız)?|pin|password|passwort|kennwort|mot de passe|contraseña|senha",
    "код|пароль|验证码|代码|密码|コード|パスワード|暗証番号|인증번호|코드|비밀번호",
  ].join("|"),
  "i",
);

/**
 * What a one-time code looks like: four to ten characters, mostly digits.
 * Spaced or hyphenated groups ("123 456", "4839-20") count as one code.
 */
const CODE_VALUE = /\b[A-Z0-9]{2,}(?:[ -][A-Z0-9]{2,})*\b/g;

/**
 * How far after the word "code" its value may sit. Short, because the thing
 * being described is "code: 483920" — anything further away is a different
 * sentence talking about something else.
 */
const AFTER = 40;

/** And how far before, for "483920 is your login code". */
const BEFORE = 24;

/** A full stop between the word and the value means they are unrelated. */
const SENTENCE_BREAK = /[.!?]\s|[。！？]/;

/** Link paths and parameters that only ever appear on a credential URL. */
const LINK_PATH =
  /(?:magic|one[-_]?time|passwordless|reset[-_]?password|password[-_]?reset|set[-_]?password|verify|verification|confirm|activate|activation|invite|invitation|sign[-_]?in|signin|login|auth|sso|token|otp|unsubscribe[-_]?token)/i;

const LINK_PARAM = /(?:token|code|key|secret|auth|jwt|otp|magic|nonce|ticket|hash|signature|confirmation|invite)/i;

/** Opaque enough to be a credential rather than an id someone might cite. */
const OPAQUE_MIN = 16;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

export function stripSecrets(raw: string): Stripped {
  const removed = new Set<SecretKind>();

  // Links first: a code sitting inside a URL should go with the URL rather
  // than leave a hole in the middle of one.
  let text = raw.replace(URL_PATTERN, (url) => {
    if (!isCredentialUrl(url)) return url;
    removed.add("link");
    return LINK_MARK;
  });

  text = stripCodes(text, () => removed.add("code"));
  return { text, removed: [...removed] };
}

/** True when a URL's only plausible purpose is to log someone in. */
function isCredentialUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/[.,;:]+$/, ""));
  } catch {
    return false;
  }
  if (LINK_PATH.test(parsed.pathname)) return true;

  for (const [name, value] of parsed.searchParams) {
    if (LINK_PARAM.test(name) && value.length >= 8) return true;
    // An unnamed blob long enough to be a token is one whatever it is called.
    if (value.length >= OPAQUE_MIN && /^[A-Za-z0-9._~%-]+$/.test(value) && /\d/.test(value)) return true;
  }
  // …/<40 opaque characters>, the shape of a reset link with no query at all.
  return parsed.pathname.split("/").some((part) => part.length >= 32 && /^[A-Za-z0-9._-]+$/.test(part) && /\d/.test(part));
}

/**
 * Removes a value only when two things are true at once: the message is
 * about logging in at all, and the value is what the word "code" is pointing
 * at. Either test alone is far too eager — an invoice says "ürün kodu" and a
 * newsletter says "giriş yapın", and neither contains a credential.
 */
function stripCodes(text: string, note: () => void): string {
  const lowered = text.toLowerCase();
  // Test one: is this a login at all? Without it, nothing is a code.
  if (!CODE_WORDS.test(lowered)) return text;

  // Test two: where the message names the thing itself.
  const nouns: { start: number; end: number }[] = [];
  for (const hit of lowered.matchAll(new RegExp(CODE_NOUN.source, "gi"))) {
    if (hit.index !== undefined) nouns.push({ start: hit.index, end: hit.index + hit[0].length });
  }
  if (nouns.length === 0) return text;

  return text.replace(CODE_VALUE, (value, offset: number) => {
    const bare = value.replace(/[ -]/g, "");
    if (bare.length < 4 || bare.length > 10) return value;
    // A code is mostly digits; a word in capitals is not a code.
    if ((bare.match(/\d/g)?.length ?? 0) < bare.length / 2) return value;
    // Part of a larger number — a price, a total, a year in a range.
    if (/[\d.,]/.test(text[offset - 1] ?? "")) return value;
    if (!pointsAt(text, nouns, offset, offset + value.length)) return value;
    note();
    return CODE_MARK;
  });
}

/** Whether one of the "code" words is actually introducing this value. */
function pointsAt(text: string, nouns: { start: number; end: number }[], from: number, to: number): boolean {
  return nouns.some((noun) => {
    // "code: 483920" — the usual shape, the word first.
    if (noun.end <= from && from - noun.end <= AFTER) return !SENTENCE_BREAK.test(text.slice(noun.end, from));
    // "483920 is your login code" — the value first.
    if (to <= noun.start && noun.start - to <= BEFORE) return !SENTENCE_BREAK.test(text.slice(to, noun.start));
    return false;
  });
}

/** The line that goes above a message the filter touched. */
export function redactionNote(removed: readonly SecretKind[]): string {
  if (removed.length === 0) return "";
  const what = removed.includes("code")
    ? removed.includes("link")
      ? "a verification code and a sign-in link"
      : "a verification code"
    : "a sign-in link";
  return `[This message contained ${what}, which was not shown to you. Tell the user to open the message themselves; do not ask them for the code or guess it.]`;
}
