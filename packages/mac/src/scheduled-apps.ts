/**
 * Which installed app a scheduled task is being set up for. Stored by bundle id:
 * the name in chat can be "Excel" or "Notlar", and the app need not be open.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { t } from "@vunemi/i18n";
import type { MacApp } from "./helper.js";
import { notScheduledReason } from "./policy.js";

const run = promisify(execFile);

export interface InstalledApp { name: string; bundleId: string; category?: string }

const FOLDERS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

async function readBundle(path: string): Promise<InstalledApp | null> {
  try {
    const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(path, "Contents/Info.plist")]);
    const plist = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof plist.CFBundleIdentifier !== "string") return null;
    return { name: basename(path, ".app"), bundleId: plist.CFBundleIdentifier, ...(typeof plist.LSApplicationCategoryType === "string" && { category: plist.LSApplicationCategoryType }) };
  } catch {
    return null;
  }
}

function bundlesNamed(wanted: string, folders: readonly string[]): string[] {
  const lower = wanted.toLocaleLowerCase("tr");
  const all = folders.filter(existsSync).flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".app")).map((f) => join(dir, f)));
  const named = (match: (name: string) => boolean): string[] => all.filter((p) => match(basename(p, ".app").toLocaleLowerCase("tr")));
  const exact = named((n) => n === lower);
  return exact.length ? exact : named((n) => n.includes(lower));
}

/** A localized name ("Notlar") isn't in the folder; Spotlight knows the name people see. */
async function bundlesShownAs(wanted: string): Promise<string[]> {
  if (/["\\*]/.test(wanted)) return [];
  try {
    const { stdout } = await run("/usr/bin/mdfind", [`kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${wanted}"cd`], { timeout: 5_000 });
    return stdout.split("\n").filter((p) => p.endsWith(".app"));
  } catch {
    return [];
  }
}

export interface AppLookup { running(): Promise<MacApp[]>; folders?: readonly string[] }

/** The app these words mean, if a scheduled task may act in it; throws a plain reason. */
export async function scheduledApp(wanted: string, look: AppLookup): Promise<{ name: string; bundleId: string }> {
  const name = wanted.trim();
  if (!name) throw new Error(t("mac.desktop.whichApp"));
  const lower = name.toLocaleLowerCase("tr");
  const open = await look.running().catch((): MacApp[] => []);
  const opened = open.filter((a) => a.bundleId.toLowerCase() === lower || a.name.toLocaleLowerCase("tr") === lower);
  let paths: string[] = [];
  const found: InstalledApp[] = [];
  if (opened.length === 0) {
    paths = bundlesNamed(name, look.folders ?? FOLDERS);
    if (paths.length === 0) paths = await bundlesShownAs(name);
    for (const path of paths) {
      const app = await readBundle(path);
      if (app) found.push(app);
    }
  }
  const unique = [...new Map([...opened.map((a) => ({ name: a.name, bundleId: a.bundleId })), ...found].map((a) => [a.bundleId, a] as const)).values()];
  if (unique.length === 0) throw new Error(t("mac.policy.notInstalled", { app: name }));
  if (unique.length > 1) throw new Error(t("mac.policy.whichOne", { app: name, apps: unique.map((a) => a.name).join(", ") }));
  const app = unique[0]!;
  // An open app's category is in its bundle, like a closed one's.
  const category = found[0]?.category ?? (await Promise.all(bundlesNamed(app.name, look.folders ?? FOLDERS).map(readBundle))).find((b) => b?.bundleId === app.bundleId)?.category;
  const blocked = notScheduledReason({ ...app, ...(category && { category }) });
  if (blocked) throw new Error(blocked);
  return { name: app.name, bundleId: app.bundleId };
}
