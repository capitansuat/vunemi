/**
 * Makes macOS willing to ask the user for permissions while developing.
 *
 * TCC does not grant a permission to whichever process happens to call the
 * API; it grants it to the *responsible* process, which for a helper spawned
 * by an app is the app bundle. In development that bundle is Electron's own
 * `Electron.app` from node_modules, and it carries none of the usage strings
 * macOS insists on — so a calendar request is refused instantly, with no
 * dialog at all. Nothing is broken and nothing is logged; the app simply
 * looks like it is ignoring the button.
 *
 * This writes the usage strings into that development bundle and re-signs it,
 * so the prompts appear. It changes only node_modules, so a reinstall undoes
 * it and it runs again from `pnpm dev`. The packaged app gets the same keys
 * from the build config instead.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Written into the bundle, and shown in the permission dialogs. */
const KEYS = {
  NSCalendarsFullAccessUsageDescription:
    "Vunemi reads your calendar and adds events when you ask it to.",
  NSRemindersFullAccessUsageDescription: "Vunemi reads your reminders and adds new ones when you ask it to.",
  NSCalendarsUsageDescription: "Vunemi reads your calendar and adds events when you ask it to.",
  NSRemindersUsageDescription: "Vunemi reads your reminders and adds new ones when you ask it to.",
  NSMicrophoneUsageDescription: "Vunemi turns what you say into text. Your voice stays on this Mac.",
  NSAppleEventsUsageDescription: "Vunemi asks for this to use the apps you allow it to.",
};

function findElectronApp() {
  const roots = ["node_modules/.pnpm", "node_modules"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate =
        root === "node_modules/.pnpm"
          ? join(root, entry, "node_modules/electron/dist/Electron.app")
          : join(root, entry, "dist/Electron.app");
      if (entry.startsWith("electron") && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const app = findElectronApp();
if (!app) {
  // Not an error: someone may be running this outside a dev install.
  console.log("[ocak] Electron.app bulunamadı, izin anahtarları atlandı.");
  process.exit(0);
}

const plist = join(app, "Contents/Info.plist");

// plutil rather than PlistBuddy: these strings contain commas and
// apostrophes, and PlistBuddy parses its own little command language where
// plutil just takes the value as an argument.
const read = (key) => {
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

let changed = false;
for (const [key, value] of Object.entries(KEYS)) {
  if (read(key) === value) continue;
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  changed = true;
}

if (!changed) process.exit(0);

// Editing the bundle invalidates its signature, and an invalid signature is
// its own silent failure — macOS refuses to launch it.
try {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--deep", app], { stdio: "pipe" });
  console.log("[ocak] Electron.app'e izin metinleri yazıldı ve yeniden imzalandı.");
} catch (err) {
  console.error("[ocak] Electron.app yeniden imzalanamadı:", err instanceof Error ? err.message : err);
  process.exit(1);
}
