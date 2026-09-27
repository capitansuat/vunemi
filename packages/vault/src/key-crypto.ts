/**
 * The vault's encryption: AES-256-GCM, with a key the Swift helper keeps in
 * the login keychain and hands over at startup.
 *
 * Electron's safeStorage did this before, and it could not work for Vunemi:
 * it refuses before the app is ready, and after that the keychain identifies
 * an app without an Apple team by the hash of its code — which changes with
 * every update, so each update locked the vault behind an approval macOS did
 * not even show. The helper's hash changes only when its Swift code does.
 *
 * The crypto starts locked. Until unlock() it encrypts nothing and decrypts
 * nothing, and says so; the vault keeps what it cannot read and opens it
 * once the key arrives (Vault.reopen).
 *
 * Format: "OCK1" | 12-byte IV | 16-byte tag | ciphertext. The magic bytes
 * both version the format and tell it apart from safeStorage's "v10…".
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretCrypto } from "./vault.js";
import { t } from "@ocak/i18n";

const MAGIC = Buffer.from("OCK1", "ascii");
const IV = 12;
const TAG = 16;
const KEY = 32;

/** Written by the old scheme (safeStorage), not by this one. */
export function isLegacyCipher(cipher: Buffer): boolean {
  return !cipher.subarray(0, MAGIC.length).equals(MAGIC);
}

export class KeyCrypto implements SecretCrypto {
  private key: Buffer | null = null;

  get available(): boolean {
    return this.key !== null;
  }

  unlock(key: Buffer): void {
    if (key.length !== KEY) throw new Error("The vault key must be 32 bytes.");
    this.key = Buffer.from(key);
  }

  encrypt(plain: string): Buffer {
    const key = this.need();
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(MAGIC);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
  }

  decrypt(sealed: Buffer): string {
    if (isLegacyCipher(sealed)) throw new Error("legacy format: waiting for migration");
    const key = this.need();
    const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV);
    const tag = sealed.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
    const body = sealed.subarray(MAGIC.length + IV + TAG);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  private need(): Buffer {
    if (!this.key) throw new Error(t("vaultStore.locked"));
    return this.key;
  }
}
