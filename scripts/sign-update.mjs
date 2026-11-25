#!/usr/bin/env node
// Signs a Windows installer or a Linux AppImage for the update feed with the
// key update-key.mjs made, and prints what goes into the feed's updateTo: its
// SHA-256 and the signature. The signed bytes are those of signedMessage() in
// apps/desktop/src/main/updates/signature.ts (a test checks they agree); the
// platform is part of them, so a Windows signature never passes for Linux.
//
// Usage: node scripts/sign-update.mjs <file> <version> <x64|arm64> <windows|linux>
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [file, version, arch, platform] = process.argv.slice(2);
if (!file || !/^\d+\.\d+\.\d+(-test\d+)?$/.test(version ?? "") || (arch !== "x64" && arch !== "arm64") || (platform !== "windows" && platform !== "linux")) {
  console.error("kullanım: node scripts/sign-update.mjs <dosya> <sürüm> <x64|arm64> <windows|linux>");
  process.exit(1);
}
const keyFile = process.env.VUNEMI_UPDATE_KEY_FILE ?? join(homedir(), ".vunemi-signing", "windows-update-ed25519.pem");
const key = createPrivateKey(readFileSync(keyFile));
const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
const message = Buffer.from(`vunemi-${platform}-update/1\n${version}\n${arch}\n${sha256}`, "utf8");
const signature = sign(null, message, key).toString("base64");
process.stdout.write(`${JSON.stringify({ sha256, signature }, null, 2)}\n`);
