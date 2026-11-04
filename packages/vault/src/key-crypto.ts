/**
 * The vault's encryption: AES-256-GCM, with a key the Swift helper keeps in
 * the login keychain and hands over at startup.
 *
 * Electron's safeStorage did this before, and it could not work for Vunemi:
 * it refuses before the app is ready, and after that the keychain identifies
 * an app without an Apple team by the hash of its code — which changes with
 * every update, so each update locked the vault behind an approval macOS did
 * not even show. A dedicated Keychain broker now stays byte-identical across desktop changes.
 *
 * The crypto starts locked. Until unlock() it encrypts nothing and decrypts
 * nothing, and says so; the vault keeps what it cannot read and opens it
 * once the key arrives (Vault.reopen).
 *
 * Format: "OCK1" | 12-byte IV | 16-byte tag | ciphertext. The magic bytes
 * both version the format and tell it apart from safeStorage's "v10…".
 *
 * On Linux the key comes from Electron's safeStorage and the system keyring
 * instead (see the desktop app's vault-key-linux.ts), and secrets are written
 * as "OCL1" | IV | tag | ciphertext: the same scheme, under a magic of its
 * own, so a vault.json carried between a Mac and a Linux machine is told
 * apart rather than tried with the wrong key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretCrypto } from "./vault.js";
import { t } from "@vunemi/i18n";

const MAGIC = Buffer.from("OCK1", "ascii");
/** Written with a key kept by the Linux keyring through safeStorage. */
export const LINUX_MAGIC = Buffer.from("OCL1", "ascii");
const IV = 12;
const TAG = 16;
const KEY = 32;

/** Written by the old scheme (safeStorage), not by this one on either system. */
export function isLegacyCipher(cipher: Buffer): boolean {
  const head = cipher.subarray(0, MAGIC.length);
  return !head.equals(MAGIC) && !head.equals(LINUX_MAGIC);
}

export class KeyCrypto implements SecretCrypto {
  private key: Buffer | null = null;

  /** macOS's "OCK1" unless told otherwise; Linux passes LINUX_MAGIC. */
  constructor(private readonly magic: Buffer = MAGIC) {
    if (!magic.equals(MAGIC) && !magic.equals(LINUX_MAGIC)) throw new Error("Unknown vault format.");
  }

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
    cipher.setAAD(this.magic);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([this.magic, iv, cipher.getAuthTag(), body]);
  }

  decrypt(sealed: Buffer): string {
    if (isLegacyCipher(sealed)) throw new Error("legacy format: waiting for migration");
    if (!sealed.subarray(0, this.magic.length).equals(this.magic)) {
      throw new Error(this.magic.equals(MAGIC) ? "written with a Linux keyring key" : "written with a macOS Keychain key");
    }
    const key = this.need();
    const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV);
    const tag = sealed.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
    const body = sealed.subarray(MAGIC.length + IV + TAG);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(this.magic);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  private need(): Buffer {
    if (!this.key) throw new Error(t("vaultStore.locked"));
    return this.key;
  }
}
