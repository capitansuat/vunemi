/**
 * The vault's own encryption, with a key the helper keeps in the keychain.
 * What matters: nothing decrypts without the key, nothing decrypts after
 * tampering, and a secret written by the old scheme is recognised as such
 * rather than mistaken for garbage.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isLegacyCipher, KeyCrypto, LINUX_MAGIC } from "../src/key-crypto.js";

const key = () => randomBytes(32);

describe("KeyCrypto", () => {
  it("round-trips a secret once it has its key", () => {
    const crypto = new KeyCrypto();
    crypto.unlock(key());
    expect(crypto.decrypt(crypto.encrypt("uygulama parolası"))).toBe("uygulama parolası");
  });

  it("is unavailable, and says so, until the key arrives", () => {
    const crypto = new KeyCrypto();
    expect(crypto.available).toBe(false);
    expect(() => crypto.encrypt("x")).toThrow(/kilitli/);
    const sealed = (() => {
      const other = new KeyCrypto();
      other.unlock(key());
      return other.encrypt("x");
    })();
    expect(() => crypto.decrypt(sealed)).toThrow(/kilitli/);
  });

  it("refuses a different key", () => {
    const a = new KeyCrypto();
    a.unlock(key());
    const b = new KeyCrypto();
    b.unlock(key());
    expect(() => b.decrypt(a.encrypt("gizli"))).toThrow();
  });

  it("refuses a ciphertext that was tampered with", () => {
    const crypto = new KeyCrypto();
    crypto.unlock(key());
    const sealed = crypto.encrypt("gizli");
    sealed[sealed.length - 1]! ^= 1;
    expect(() => crypto.decrypt(sealed)).toThrow();
  });

  it("never encrypts the same secret the same way twice", () => {
    const crypto = new KeyCrypto();
    crypto.unlock(key());
    expect(crypto.encrypt("aynı").equals(crypto.encrypt("aynı"))).toBe(false);
  });

  it("tells the old scheme apart, so it can be migrated rather than lost", () => {
    const crypto = new KeyCrypto();
    crypto.unlock(key());
    // Electron's safeStorage on macOS writes "v10" followed by AES-CBC.
    const legacy = Buffer.concat([Buffer.from("v10"), randomBytes(32)]);
    expect(isLegacyCipher(legacy)).toBe(true);
    expect(isLegacyCipher(crypto.encrypt("yeni"))).toBe(false);
    expect(() => crypto.decrypt(legacy)).toThrow(/legacy format/);
  });

  it("rejects a key of the wrong size", () => {
    expect(() => new KeyCrypto().unlock(randomBytes(16))).toThrow();
  });
});

describe("KeyCrypto on Linux", () => {
  it("writes its own magic, so a Linux vault is never read as a macOS one", () => {
    const linux = new KeyCrypto(LINUX_MAGIC);
    linux.unlock(key());
    const sealed = linux.encrypt("anahtar");
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("OCL1");
    expect(linux.decrypt(sealed)).toBe("anahtar");
    expect(isLegacyCipher(sealed)).toBe(false);
  });

  it("keeps macOS's format exactly as it was by default", () => {
    const mac = new KeyCrypto();
    mac.unlock(key());
    expect(mac.encrypt("x").subarray(0, 4).toString("ascii")).toBe("OCK1");
  });

  it("tells the two apart instead of trying the wrong key", () => {
    const k = key();
    const mac = new KeyCrypto();
    mac.unlock(k);
    const linux = new KeyCrypto(LINUX_MAGIC);
    linux.unlock(k);
    expect(() => linux.decrypt(mac.encrypt("x"))).toThrow(/macOS Keychain/);
    expect(() => mac.decrypt(linux.encrypt("x"))).toThrow(/Linux keyring/);
  });

  it("binds the magic into what GCM authenticates", () => {
    const linux = new KeyCrypto(LINUX_MAGIC);
    const k = key();
    linux.unlock(k);
    const sealed = linux.encrypt("x");
    const relabelled = Buffer.concat([Buffer.from("OCK1"), sealed.subarray(4)]);
    const mac = new KeyCrypto();
    mac.unlock(k);
    expect(() => mac.decrypt(relabelled)).toThrow();
  });

  it("knows no third format", () => {
    expect(() => new KeyCrypto(Buffer.from("XXX1"))).toThrow(/Unknown vault format/);
  });
});
