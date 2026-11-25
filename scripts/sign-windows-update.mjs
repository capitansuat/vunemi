#!/usr/bin/env node
// Kept for the Windows release steps written before Linux updates: the same
// as `node scripts/sign-update.mjs <installer.exe> <version> <arch> windows`.
//
// Usage: node scripts/sign-windows-update.mjs <installer.exe> <version> <x64|arm64>
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [installer, version, arch] = process.argv.slice(2);
const script = join(dirname(fileURLToPath(import.meta.url)), "sign-update.mjs");
const result = spawnSync(process.execPath, [script, installer ?? "", version ?? "", arch ?? "", "windows"], { stdio: "inherit" });
process.exit(result.status ?? 1);
