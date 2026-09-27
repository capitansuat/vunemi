/** Discover installed scriptable applications and cache their bounded dictionaries. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { blockedReason } from "@vunemi/mac";
import { promisify } from "node:util";
import { blockedCommand, parseDictionary, type ScriptDictionary } from "./dictionary.js";

const run = promisify(execFile);
const STANDARD = "/System/Library/ScriptingDefinitions/CocoaStandard.sdef";
const SDEF = "/usr/bin/sdef";
const PLUTIL = "/usr/bin/plutil";
const MAX_APPS = 250;
const MAX_CACHE_BYTES = 2_000_000;

export interface ScriptableApp {
  name: string;
  bundleId: string;
  path: string;
  version: string;
}

const BLOCKED_IDS = new Set([
  "com.apple.terminal", "com.googlecode.iterm2", "com.apple.systemevents",
  "com.apple.scripteditor2", "com.apple.keychainaccess", "com.apple.systempreferences",
  "com.apple.shortcuts", "com.apple.automator", "com.vunemi.app",
  "com.apple.databaseevents", "com.apple.folderactionssetup", "com.apple.folderactionsdispatcher",
]);
const BLOCKED_NAMES = /^(terminal|iterm2?|system events|script editor|keychain access|system settings|shortcuts(?: events)?|automator|vunemi|database events|folder actions setup|folderactionsdispatcher|folder actions dispatcher)$/i;

export function blockedApp(app: Pick<ScriptableApp, "name" | "bundleId">): boolean {
  return BLOCKED_IDS.has(app.bundleId.toLowerCase()) || app.bundleId.toLowerCase().startsWith("com.apple.shortcuts.")
    || BLOCKED_NAMES.test(app.name.trim()) || blockedReason({ name: app.name, bundleId: app.bundleId }) !== null;
}

async function plist(info: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await run(PLUTIL, ["-extract", key, "raw", "-o", "-", info], { timeout: 3_000, maxBuffer: 4_096 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function applicationPaths(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  async function visit(dir: string, depth: number, root: string): Promise<void> {
    if (found.length >= MAX_APPS) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_APPS) break;
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".app")) {
        let real;
        try { real = await realpath(path); }
        catch { continue; }
        if (seen.has(real) || (!real.startsWith(root + sep) && real !== root)) continue;
        if (!existsSync(join(real, "Contents", "Info.plist"))) continue;
        seen.add(real);
        found.push(real);
      } else if (depth > 0 && entry.isDirectory() && !entry.name.startsWith(".")) {
        await visit(path, depth - 1, root);
      }
    }
  }
  for (const root of roots) await visit(root, 2, root);
  return found;
}

function cachedDictionary(value: unknown): value is ScriptDictionary {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ScriptDictionary>;
  return Array.isArray(entry.suites) && Array.isArray(entry.classes) && Array.isArray(entry.commands)
    && entry.classes.every((item) => typeof item?.name === "string" && Array.isArray(item.properties) && Array.isArray(item.elements))
    && entry.commands.every((item) => typeof item?.name === "string" && typeof item.jsName === "string" && !blockedCommand(item.name)
      && Array.isArray(item.parameters) && Array.isArray(item.directTypes));
}

export class ScriptableCatalog {
  private discovered: Promise<ScriptableApp[]> | null = null;
  private standard: Promise<string> | null = null;
  private readonly dictionaryPromises = new Map<string, Promise<ScriptDictionary>>();

  constructor(
    private readonly cacheDir: string,
    private readonly roots: readonly string[] = ["/Applications", "/System/Applications", "/System/Library/CoreServices", join(homedir(), "Applications")],
  ) {}

  list(): Promise<ScriptableApp[]> {
    this.discovered ??= this.scan().catch((error: unknown) => { this.discovered = null; throw error; });
    return this.discovered;
  }

  async find(nameOrId: string): Promise<ScriptableApp> {
    const key = String(nameOrId ?? "").trim().toLowerCase();
    if (!key) throw new Error("An application name or bundle ID is required.");
    const matches = (await this.list()).filter((app) => app.bundleId.toLowerCase() === key || app.name.toLowerCase() === key);
    if (matches.length !== 1) throw new Error(matches.length ? "Application name is ambiguous; use its bundle ID." : "No permitted scriptable application matches that name.");
    return matches[0]!;
  }

  async dictionary(app: ScriptableApp): Promise<ScriptDictionary> {
    const key = `${app.bundleId}:${app.version}:${app.path}`;
    let pending = this.dictionaryPromises.get(key);
    if (!pending) {
      pending = this.loadDictionary(app).catch((error: unknown) => { this.dictionaryPromises.delete(key); throw error; });
      this.dictionaryPromises.set(key, pending);
    }
    return pending;
  }

  private async scan(): Promise<ScriptableApp[]> {
    const paths = await applicationPaths(this.roots);
    const found: ScriptableApp[] = [];
    const seenIds = new Set<string>();
    // Bounded batches keep sdef from opening hundreds of processes at once.
    for (let start = 0; start < paths.length; start += 4) {
      const batch = await Promise.all(paths.slice(start, start + 4).map(async (path): Promise<ScriptableApp | null> => {
        const info = join(path, "Contents", "Info.plist");
        const bundleId = await plist(info, "CFBundleIdentifier");
        if (!bundleId) return null;
        const name = (await plist(info, "CFBundleDisplayName")) ?? (await plist(info, "CFBundleName")) ?? basename(path, ".app");
        const app = { name, bundleId, path, version: (await plist(info, "CFBundleShortVersionString")) ?? (await plist(info, "CFBundleVersion")) ?? "unknown" };
        if (blockedApp(app)) return null;
        try {
          const dictionary = await this.dictionary(app);
          return dictionary.suites.length && (dictionary.classes.length || dictionary.commands.length) ? app : null;
        } catch { return null; }
      }));
      for (const app of batch) {
        if (app && !seenIds.has(app.bundleId.toLowerCase())) {
          seenIds.add(app.bundleId.toLowerCase());
          found.push(app);
        }
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadDictionary(app: ScriptableApp): Promise<ScriptDictionary> {
    if (blockedApp(app)) throw new Error("This application is off limits.");
    const info = join(app.path, "Contents", "Info.plist");
    const infoStat = await stat(info);
    const key = createHash("sha256").update(`${app.bundleId}\n${app.path}\n${app.version}\n${infoStat.mtimeMs}`).digest("hex").slice(0, 24);
    const file = join(this.cacheDir, `${key}.json`);
    try {
      const cached = await readFile(file, "utf8");
      if (cached.length <= MAX_CACHE_BYTES) {
        const parsed: unknown = JSON.parse(cached);
        if (cachedDictionary(parsed)) return parsed;
      }
    } catch { /* A missing or damaged cache is rebuilt. */ }
    const { stdout } = await run(SDEF, [app.path], { timeout: 20_000, maxBuffer: 2_000_000 });
    this.standard ??= readFile(STANDARD, "utf8").catch(() => "");
    const dictionary = parseDictionary(stdout, await this.standard);
    const encoded = JSON.stringify(dictionary);
    if (encoded.length <= MAX_CACHE_BYTES) {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, encoded, { mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    }
    return dictionary;
  }
}
