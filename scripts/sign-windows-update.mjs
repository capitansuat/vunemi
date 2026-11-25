#!/usr/bin/env node
// Signs a Windows installer for the update feed with the key update-key.mjs
// made, and prints what goes into the feed's updateTo: its SHA-256 and the
// signature. The signed bytes are those of signedMessage() in
// apps/desktop/src/main/updates/signature.ts (a test checks they agree).
//
// Usage: node scripts/sign-windows-update.mjs <installer.exe> <version> <x64|arm64>
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [installer, version, arch] = process.argv.slice(2);
if (!installer || !/^\d+\.\d+\.\d+(-test\d+)?$/.test(version ?? "") || (arch !== "x64" && arch !== "arm64")) {
  console.error("kullanım: node scripts/sign-windows-update.mjs <kurulum.exe> <sürüm> <x64|arm64>");
  process.exit(1);
}
const file = process.env.VUNEMI_UPDATE_KEY_FILE ?? join(homedir(), ".vunemi-signing", "windows-update-ed25519.pem");
const key = createPrivateKey(readFileSync(file));
const sha256 = createHash("sha256").update(readFileSync(installer)).digest("hex");
const message = Buffer.from(`vunemi-windows-update/1\n${version}\n${arch}\n${sha256}`, "utf8");
const signature = sign(null, message, key).toString("base64");
process.stdout.write(`${JSON.stringify({ sha256, signature }, null, 2)}\n`);
