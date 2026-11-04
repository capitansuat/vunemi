/**
 * The Vault's key on Linux.
 *
 * macOS keeps the key in the login Keychain behind a signed Swift helper.
 * Linux has neither, so the key is kept in a file in the data folder,
 * encrypted by Electron's safeStorage, which on Linux asks the desktop's
 * keyring (libsecret: GNOME Keyring, KeePassXC…; or KWallet) for its own key.
 *
 * Where there is no keyring, safeStorage falls back to "basic_text": a key
 * built into Chromium, which protects nothing. Then Vunemi stores no secret
 * at all and tells the user what to install. It never writes a vault key, or
 * a secret, that anyone with the file could read.
 *
 * safeStorage exists only in the main process, so on Linux the key passes
 * through main on its way to the Vault process; main keeps no copy.
 *
 * File format: "VKL1" | safeStorage ciphertext of the base64 key.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LINUX_KEY_FILE = "vault-key.linux";
const MAGIC = Buffer.from("VKL1", "ascii");
const KEY_BYTES = 32;

/** Backends that keep safeStorage's key in a real keyring. */
export const KEYRING_BACKENDS: ReadonlySet<string> = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

/** The part of Electron's safeStorage this needs; a fake in tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export type LinuxKeyResult =
  | { ok: true; key: Buffer; created: boolean }
  /** No keyring: nothing may be stored. `backend` is what safeStorage chose instead. */
  | { ok: false; reason: "no-keyring"; backend: string }
  /** A key file is there but the keyring cannot open it (another keyring, or it was reset). Kept as it is. */
  | { ok: false; reason: "unreadable"; detail: string };

/** Which backend safeStorage uses, and whether it is one that protects anything. */
export function keyringState(storage: SafeStorageLike): { backend: string; usable: boolean } {
  // Asking whether encryption is available is what makes safeStorage pick its backend.
  const available = storage.isEncryptionAvailable();
  const backend = storage.getSelectedStorageBackend();
  return { backend, usable: available && KEYRING_BACKENDS.has(backend) };
}

/**
 * Reads the Vault key, or makes one the first time. A key file that cannot be
 * decrypted is never replaced: the secrets sealed with it stay recoverable if
 * the keyring that made it comes back.
 */
export function linuxVaultKey(storage: SafeStorageLike, userData: string): LinuxKeyResult {
  const { backend, usable } = keyringState(storage);
  if (!usable) return { ok: false, reason: "no-keyring", backend };
  const file = join(userData, LINUX_KEY_FILE);
  if (existsSync(file)) {
    try {
      const sealed = readFileSync(file);
      if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Vunemi key file");
      const key = Buffer.from(storage.decryptString(sealed.subarray(MAGIC.length)), "base64");
      if (key.length !== KEY_BYTES) throw new Error("wrong key length");
      return { ok: true, key, created: false };
    } catch (err) {
      return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const key = randomBytes(KEY_BYTES);
  const sealed = Buffer.concat([MAGIC, storage.encryptString(key.toString("base64"))]);
  // Written whole or not at all, readable by this user only.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, sealed, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  return { ok: true, key, created: true };
}
