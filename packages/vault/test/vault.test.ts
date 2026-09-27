/**
 * The Vault's promise is narrow and testable: the value goes in, and the only
 * ways out are `use()` — called in the main process — and a mask. Anything
 * else the model could reach must show the name instead.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyCrypto } from "../src/key-crypto.js";
import { Vault, type SecretCrypto } from "../src/vault.js";

/** Reversible and obviously not real encryption — enough to prove the seam. */
const fake: SecretCrypto = {
  available: true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (cipher) => {
    const text = cipher.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("başka bir anahtarla yazılmış");
    return text.slice(4);
  },
};

const unavailable: SecretCrypto = {
  available: false,
  encrypt: () => {
    throw new Error("yok");
  },
  decrypt: () => {
    throw new Error("yok");
  },
};

describe("Vault", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocak-vault-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const file = () => join(dir, "vault.json");

  it("tells the world names, never values", () => {
    const vault = new Vault(dir, fake);
    vault.set("github-token", "ghp_9Qk2s7Lx0aB4tN1vZ", "CI için");

    expect(vault.list()).toEqual([
      expect.objectContaining({ name: "github-token", note: "CI için" }),
    ]);
    // Whatever a caller serialises, the value is not in it.
    expect(JSON.stringify(vault.list())).not.toContain("ghp_");
    expect(vault.has("github-token")).toBe(true);
    expect(vault.use("github-token")).toBe("ghp_9Qk2s7Lx0aB4tN1vZ");
  });

  it("never writes a secret to disk in the clear", () => {
    const vault = new Vault(dir, fake);
    vault.set("api", "sk-live-7731-aaaa-bbbb");
    const onDisk = readFileSync(file(), "utf8");
    expect(onDisk).not.toContain("sk-live-7731-aaaa-bbbb");
    expect(onDisk).toContain("api");
    // And it stays readable only by this user.
    const stored = JSON.parse(onDisk) as { entries: { cipher: string }[] };
    expect(Buffer.from(stored.entries[0]!.cipher, "base64").toString("utf8")).toBe(
      "enc:sk-live-7731-aaaa-bbbb",
    );
  });

  it("clears secrets from memory and the encrypted file", () => {
    const vault = new Vault(dir, fake);
    vault.set("mail", "app-password-12345");
    vault.clear();
    expect(vault.list()).toEqual([]);
    expect(() => vault.use("mail")).toThrow();
    expect(new Vault(dir, fake).list()).toEqual([]);
    expect(readFileSync(file(), "utf8")).not.toContain("app-password-12345");
  });

  it("refuses to store anything when the machine has no secure storage", () => {
    const vault = new Vault(dir, unavailable);
    expect(vault.available).toBe(false);
    expect(() => vault.set("api", "sk-live-7731")).toThrow(/güvenli saklama/);
    expect(vault.list()).toEqual([]);
  });

  it("rejects names that aren't names", () => {
    const vault = new Vault(dir, fake);
    expect(() => vault.set("iki kelime", "uzun-bir-değer")).toThrow(/Ad yalnızca/);
    expect(() => vault.set("api", "")).toThrow(/Boş/);
  });

  it("masks a stored secret wherever it turns up", () => {
    const vault = new Vault(dir, fake);
    vault.set("api", "sk-live-7731-aaaa-bbbb");
    const page = "Anahtarınız: sk-live-7731-aaaa-bbbb — kimseyle paylaşmayın.";
    expect(vault.redact(page)).toBe("Anahtarınız: «kasadaki api» — kimseyle paylaşmayın.");
    // Every occurrence, not just the first.
    expect(vault.redact("sk-live-7731-aaaa-bbbb sk-live-7731-aaaa-bbbb")).not.toContain("sk-live");
  });

  it("masks the longest secret first, so one inside another stays whole", () => {
    const vault = new Vault(dir, fake);
    vault.set("kisa", "abcdef-1234");
    vault.set("uzun", "abcdef-1234-devami-uzun");
    expect(vault.redact("işte: abcdef-1234-devami-uzun")).toBe("işte: «kasadaki uzun»");
  });

  it("leaves short values alone: masking them would be noise, not safety", () => {
    const vault = new Vault(dir, fake);
    vault.set("pin", "1234");
    expect(vault.redact("kapı kodu 1234")).toBe("kapı kodu 1234");
  });

  it("survives a restart, and records when a secret was used", () => {
    const first = new Vault(dir, fake);
    first.set("api", "sk-live-7731-aaaa-bbbb", "fatura");
    first.use("api");

    const second = new Vault(dir, fake);
    expect(second.use("api")).toBe("sk-live-7731-aaaa-bbbb");
    const info = second.list()[0]!;
    expect(info.note).toBe("fatura");
    expect(info.lastUsedAt).toBeGreaterThan(0);
  });

  it("keeps only the name when an entry can't be decrypted here", () => {
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        entries: [{ name: "eski", createdAt: 1, cipher: Buffer.from("başka", "utf8").toString("base64") }],
      }),
    );
    const vault = new Vault(dir, fake);
    expect(vault.list()).toEqual([{ name: "eski", createdAt: 1, note: "okunamadı — yeniden gir" }]);
    expect(vault.has("eski")).toBe(false);
    expect(() => vault.use("eski")).toThrow(/Kasada/);
  });

  it("never throws away an entry it merely cannot read right now", () => {
    // After a rebuild the keychain may refuse this copy of the app. The
    // ciphertext is still the user's password; another secret being saved
    // must not be what erases it.
    const unreadable = { name: "mail.x", note: "Gmail", createdAt: 1, cipher: Buffer.from("başka", "utf8").toString("base64") };
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [unreadable] }));

    const vault = new Vault(dir, fake);
    vault.set("yeni", "bir-baska-sir");

    const stored = JSON.parse(readFileSync(file(), "utf8")) as { entries: { name: string; cipher: string; note?: string }[] };
    const kept = stored.entries.find((e) => e.name === "mail.x");
    expect(kept?.cipher).toBe(unreadable.cipher);
    // And the note the user wrote, not the "unreadable" label shown meanwhile.
    expect(kept?.note).toBe("Gmail");
  });

  it("reads the kept entry again once the keychain lets it", () => {
    const unreadable = { name: "mail.x", createdAt: 1, cipher: Buffer.from("enc:parola", "utf8").toString("base64") };
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [unreadable] }));
    const refusing: SecretCrypto = { ...fake, decrypt: () => { throw new Error("izin yok"); } };

    new Vault(dir, refusing).set("yeni", "bir-baska-sir");
    expect(new Vault(dir, fake).use("mail.x")).toBe("parola");
  });

  it("opens what it could not read, once decryption works", () => {
    // The keychain can be unavailable when the vault is first loaded and
    // available moments later; a secret should not stay locked until the
    // next launch because of when it was first asked for.
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [{ name: "mail.x", note: "Gmail", createdAt: 1, cipher: Buffer.from("enc:parola", "utf8").toString("base64") }] }));
    let ready = false;
    const late: SecretCrypto = { ...fake, decrypt: (c) => { if (!ready) throw new Error("henüz değil"); return fake.decrypt(c); } };

    const vault = new Vault(dir, late);
    expect(vault.has("mail.x")).toBe(false);
    expect(vault.unreadable()).toEqual([{ name: "mail.x", reason: "henüz değil" }]);

    ready = true;
    expect(vault.reopen()).toEqual({ opened: ["mail.x"], still: [] });
    expect(vault.use("mail.x")).toBe("parola");
    // The user's own note is back, not the "unreadable" label.
    expect(vault.list()).toEqual([expect.objectContaining({ name: "mail.x", note: "Gmail", createdAt: 1 })]);
    expect(vault.unreadable()).toEqual([]);
  });

  it("says why an entry stays locked, without ever showing its value", () => {
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [{ name: "mail.x", createdAt: 1, cipher: Buffer.from("enc:parola", "utf8").toString("base64") }] }));
    const refusing: SecretCrypto = { ...fake, decrypt: () => { throw new Error("anahtar zinciri izin vermedi"); } };
    const vault = new Vault(dir, refusing);
    expect(vault.reopen()).toEqual({ opened: [], still: [{ name: "mail.x", reason: "anahtar zinciri izin vermedi" }] });
    expect(JSON.stringify(vault.unreadable())).not.toContain("parola");
  });

  it("hands over a locked entry's ciphertext and note for migration, never a value", () => {
    const cipher = Buffer.from("başka", "utf8").toString("base64");
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [{ name: "mail.x", note: "Gmail", createdAt: 1, cipher }] }));
    const vault = new Vault(dir, fake);
    expect(vault.sealedEntries()).toEqual([{ name: "mail.x", note: "Gmail", cipher: Buffer.from(cipher, "base64") }]);

    // Migrated: re-entered under the same name, with the user's note kept.
    vault.set("mail.x", "parola", "Gmail");
    expect(vault.sealedEntries()).toEqual([]);
    expect(new Vault(dir, fake).use("mail.x")).toBe("parola");
  });

  it("replaces an unreadable entry when the user enters it again", () => {
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [{ name: "mail.x", createdAt: 1, cipher: "YmHFn2thAA==" }] }));
    const vault = new Vault(dir, fake);
    vault.set("mail.x", "yeni-parola");
    expect(new Vault(dir, fake).use("mail.x")).toBe("yeni-parola");
  });

  it("forgets an unreadable entry when told to delete it", () => {
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [{ name: "mail.x", createdAt: 1, cipher: "YmHFn2thAA==" }] }));
    new Vault(dir, fake).delete("mail.x");
    expect(new Vault(dir, fake).list()).toEqual([]);
  });

  it("forgets a deleted secret, in memory and on disk", () => {
    const vault = new Vault(dir, fake);
    vault.set("api", "sk-live-7731-aaaa-bbbb");
    vault.delete("api");
    expect(vault.list()).toEqual([]);
    expect(vault.redact("sk-live-7731-aaaa-bbbb")).toBe("sk-live-7731-aaaa-bbbb");
    expect(readFileSync(file(), "utf8")).not.toContain("enc:");
  });

  it("starts empty rather than throwing when there is no vault yet", () => {
    const vault = new Vault(dir, fake);
    expect(vault.list()).toEqual([]);
    expect(vault.redact("herhangi bir metin")).toBe("herhangi bir metin");
  });
});

describe("secrets bound to where they are used", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocak-vault-bind-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const crypto = () => {
    const c = new KeyCrypto();
    c.unlock(Buffer.alloc(32, 7));
    return c;
  };

  it("gives a bound secret only to its own servers, and remembers that after a restart", () => {
    const vault = new Vault(dir, crypto());
    vault.set("mail.a", "app-password-1", "a@example.com", ["imap:imap.example.com", "smtp:smtp.example.com"]);
    expect(vault.use("mail.a", "smtp:smtp.example.com")).toBe("app-password-1");
    expect(() => vault.use("mail.a", "smtp:evil.example")).toThrow(/mail\.a/);
    expect(() => vault.use("mail.a")).toThrow();
    const again = new Vault(dir, crypto());
    expect(again.targets("mail.a")).toEqual(["imap:imap.example.com", "smtp:smtp.example.com"]);
    expect(() => again.use("mail.a", "smtp:evil.example")).toThrow();
  });

  it("can't be moved to another server by editing the file", () => {
    const vault = new Vault(dir, crypto());
    vault.set("mail.a", "app-password-1", undefined, ["smtp:smtp.example.com"]);
    vault.set("mcp.x.TOKEN", "mcp-token-2", undefined, ["mcp:/usr/local/bin/x"]);
    // Swap the two ciphertexts: the mail password now sits under the MCP name.
    const file = join(dir, "vault.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { entries: { name: string; cipher: string }[] };
    const [a, b] = stored.entries;
    [a!.cipher, b!.cipher] = [b!.cipher, a!.cipher];
    writeFileSync(file, JSON.stringify(stored));
    const reopened = new Vault(dir, crypto());
    const mcpName = stored.entries.find((e) => e.name === "mcp.x.TOKEN")!.name;
    expect(() => reopened.use(mcpName, "mcp:/usr/local/bin/x")).toThrow();
  });

  it("lets an older unbound secret be bound once, and never widened", () => {
    const vault = new Vault(dir, crypto());
    vault.set("mail.old", "old-password");
    expect(vault.use("mail.old", "smtp:smtp.example.com")).toBe("old-password");
    vault.adopt("mail.old", ["imap:imap.example.com", "smtp:smtp.example.com"]);
    vault.adopt("mail.old", ["smtp:evil.example"]);
    expect(vault.targets("mail.old")).toEqual(["imap:imap.example.com", "smtp:smtp.example.com"]);
    expect(() => vault.use("mail.old", "smtp:evil.example")).toThrow();
    expect(new Vault(dir, crypto()).use("mail.old", "imap:imap.example.com")).toBe("old-password");
  });

  it("keeps a binding when only the value is replaced", () => {
    const vault = new Vault(dir, crypto());
    vault.set("mail.a", "first-value", undefined, ["smtp:smtp.example.com"]);
    vault.set("mail.a", "second-value");
    expect(vault.targets("mail.a")).toEqual(["smtp:smtp.example.com"]);
    expect(() => vault.use("mail.a", "smtp:evil.example")).toThrow();
  });

  it("refuses a malformed place and forgets the binding with the secret", () => {
    const vault = new Vault(dir, crypto());
    expect(() => vault.set("x.y", "value-123", undefined, ["no colon"])).toThrow();
    vault.set("x.y", "value-123", undefined, ["tenami:outbox"]);
    vault.delete("x.y");
    vault.set("x.y", "value-456");
    expect(vault.targets("x.y")).toEqual([]);
    expect(vault.redact("value-456")).not.toContain("value-456");
  });
});
