#!/usr/bin/env node
// Makes the key pair Windows and Linux updates are signed with, once. The private key
// goes to ~/.vunemi-signing/windows-update-ed25519.pem (only you can read it;
// back it up like the .p12, outside every repository); the public key is
// printed for apps/desktop/src/main/updates/update-key.ts. An existing key
// is never replaced: an app that ships a public key accepts nothing else.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = process.env.VUNEMI_UPDATE_KEY_FILE ?? join(homedir(), ".vunemi-signing", "windows-update-ed25519.pem");
if (existsSync(file)) {
  console.error(`! anahtar zaten var, değiştirilmez: ${file}`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
console.error(`› gizli anahtar: ${file} (yedekle; repoya koyma)`);
process.stdout.write(publicKey.export({ type: "spki", format: "pem" }).toString());
