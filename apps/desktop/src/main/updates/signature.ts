/**
 * The Windows installer and the Linux AppImage are unsigned (no paid
 * certificate, no store), so Vunemi checks its own signature instead: an
 * Ed25519 signature, made at release with the key only the maintainer holds,
 * over the platform, the version, the architecture and the file's SHA-256. A changed feed on vunemi.com or a changed file on
 * GitHub can't produce one, which is what the Mac gets from its updater
 * installing only an app signed like the running one.
 */
import { createPublicKey, verify } from "node:crypto";

export type UpdateArch = "x64" | "arm64";
/** Which system's file is signed: one platform's signature never passes for the other's. */
export type UpdatePlatform = "windows" | "linux";

const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** What is signed; scripts/sign-update.mjs signs the same bytes. Windows' are those its first releases were signed with. */
export function signedMessage(platform: UpdatePlatform, version: string, arch: UpdateArch, sha256: string): Buffer {
  return Buffer.from(`vunemi-${platform}-update/1\n${version}\n${arch}\n${sha256.toLowerCase()}`, "utf8");
}

/** Whether the signature is the key's, over exactly this platform, version, architecture and contents. Never throws. */
export function verifyUpdate(publicKeyPem: string, platform: UpdatePlatform, version: string, arch: UpdateArch, sha256: string, signatureBase64: unknown): boolean {
  if (!SHA256.test(sha256) || typeof signatureBase64 !== "string" || !BASE64.test(signatureBase64)) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;
    return verify(null, signedMessage(platform, version, arch, sha256), key, signature);
  } catch {
    return false;
  }
}
