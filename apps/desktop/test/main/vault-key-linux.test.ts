/**
 * The Vault's key on Linux: kept by the system keyring through safeStorage,
 * or not at all. Synthetic keys and a fake safeStorage only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyCrypto, LINUX_MAGIC, Vault } from "@vunemi/vault";
import { KEYRING_BACKENDS, keyringState, LINUX_KEY_FILE, linuxVaultKey, type SafeStorageLike } from "../../src/main/vault-key-linux.js";

/** A stand-in for safeStorage: reversible, and marked so a test can see it was used. */
function storage(backend: string, available = true): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => { calls.push("available"); return available; },
    getSelectedStorageBackend: () => { calls.push("backend"); return backend; },
    encryptString: (plain) => { calls.push("encrypt"); return Buffer.from(`ss:${Buffer.from(plain).reverse().toString("latin1")}`, "latin1"); },
    decryptString: (cipher) => {
      calls.push("decrypt");
      const text = cipher.toString("latin1");
      if (!text.startsWith("ss:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(text.slice(3), "latin1").reverse().toString();
    },
  };
}

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-linux-key-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the Linux vault key", () => {
  it("accepts only backends that keep the key in a real keyring", () => {
    expect([...KEYRING_BACKENDS].sort()).toEqual(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
    expect(keyringState(storage("gnome_libsecret")).usable).toBe(true);
    expect(keyringState(storage("kwallet6")).usable).toBe(true);
    expect(keyringState(storage("basic_text")).usable).toBe(false);
    expect(keyringState(storage("unknown")).usable).toBe(false);
    expect(keyringState(storage("gnome_libsecret", false)).usable).toBe(false);
  });

  it("asks whether encryption is available before reading the backend, which is what selects it", () => {
    const fake = storage("gnome_libsecret");
    keyringState(fake);
    expect(fake.calls.slice(0, 2)).toEqual(["available", "backend"]);
  });

  it("refuses without a keyring and writes nothing at all", () => {
    for (const backend of ["basic_text", "unknown"]) {
      const fake = storage(backend);
      expect(linuxVaultKey(fake, dir)).toEqual({ ok: false, reason: "no-keyring", backend });
      expect(fake.calls).not.toContain("encrypt");
    }
    expect(existsSync(join(dir, LINUX_KEY_FILE))).toBe(false);
  });

  it("makes a key once, sealed by the keyring, readable by this user only", () => {
    const first = linuxVaultKey(storage("gnome_libsecret"), dir);
    expect(first.ok && first.created).toBe(true);
    const file = join(dir, LINUX_KEY_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const sealed = readFileSync(file);
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("VKL1");
    // The key itself is not in the file.
    if (!first.ok) throw new Error("no key");
    expect(sealed.includes(first.key)).toBe(false);
    expect(sealed.includes(Buffer.from(first.key.toString("base64")))).toBe(false);

    const again = linuxVaultKey(storage("gnome_libsecret"), dir);
    expect(again.ok && !again.created && again.key.equals(first.key)).toBe(true);
  });

  it("keeps a key file the keyring can't open, and never replaces it", () => {
    const file = join(dir, LINUX_KEY_FILE);
    writeFileSync(file, Buffer.concat([Buffer.from("VKL1"), Buffer.from("from another keyring")]));
    const before = readFileSync(file);
    const result = linuxVaultKey(storage("kwallet5"), dir);
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    expect(readFileSync(file).equals(before)).toBe(true);
    writeFileSync(file, "not ours");
    expect(linuxVaultKey(storage("kwallet5"), dir)).toMatchObject({ ok: false, reason: "unreadable", detail: "not a Vunemi key file" });
  });

  it("without a key the Vault stores nothing, in the clear or otherwise", () => {
    const crypto = new KeyCrypto(LINUX_MAGIC);
    const vault = new Vault(dir, crypto);
    expect(() => vault.set("github-token", "synthetic-secret-value")).toThrow();
    const stored = existsSync(join(dir, "vault.json")) ? readFileSync(join(dir, "vault.json"), "utf8") : "";
    expect(stored).not.toContain("synthetic-secret-value");
  });

  it("with the keyring's key the Vault seals secrets in the Linux format", () => {
    const result = linuxVaultKey(storage("gnome_libsecret"), dir);
    if (!result.ok) throw new Error("no key");
    const crypto = new KeyCrypto(LINUX_MAGIC);
    crypto.unlock(result.key);
    const vault = new Vault(dir, crypto);
    vault.set("github-token", "synthetic-secret-value");
    const stored = readFileSync(join(dir, "vault.json"), "utf8");
    expect(stored).not.toContain("synthetic-secret-value");
    const cipher = Buffer.from((JSON.parse(stored) as { entries: { cipher: string }[] }).entries[0]!.cipher, "base64");
    expect(cipher.subarray(0, 4).toString("ascii")).toBe("OCL1");
    // Read back after a restart with the same keyring.
    const again = linuxVaultKey(storage("gnome_libsecret"), dir);
    if (!again.ok) throw new Error("no key");
    const reopened = new KeyCrypto(LINUX_MAGIC);
    reopened.unlock(again.key);
    expect(new Vault(dir, reopened).has("github-token")).toBe(true);
  });
});
