/**
 * Updates on Windows, behind the same Updater interface Squirrel.Mac fills
 * on the Mac. The offer has already been read with suspicion (feed.ts: the
 * releases' own address, the maintainer's signature over version,
 * architecture and SHA-256); this downloads that installer, keeps it only
 * when its SHA-256 is the signed one, checks it again just before it runs,
 * and runs it silently after Vunemi quits. Nothing here is reachable from
 * the agent.
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import type { Offer } from "./feed.js";
import type { Updater } from "./service.js";
import type { UpdateArch } from "./signature.js";

export interface WindowsUpdaterDeps {
  /** Where installers are kept until they run: inside Vunemi's own data folder. */
  dir: string;
  arch: UpdateArch;
  download(url: string, file: string): Promise<void>;
  spawn(file: string, args: string[]): void;
  /** Quits Vunemi so the installer can replace it. */
  quit(): void;
}

/** The installer's switches: silent, an update, and start Vunemi again afterwards. */
const INSTALL_ARGS = ["/S", "--updated", "--force-run"];

function sha256(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
  });
}

export class WindowsUpdater implements Updater {
  private offer: Offer | null = null;
  private staged: { file: string; sha256: string } | null = null;
  private readonly downloaded: (() => void)[] = [];
  private readonly failed: ((error: Error) => void)[] = [];

  constructor(private readonly deps: WindowsUpdaterDeps) {}

  /**
   * Installers from an earlier run (one that ran, or a download cut short):
   * nothing staged outlives a restart, so at start they are only taking room,
   * in the roaming part of the profile. Other files in the folder stay.
   */
  forgetOld(): void {
    let names: string[];
    try {
      names = readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^Vunemi-Setup-.+\.exe(\.part)?$/.test(name)) continue;
      try {
        rmSync(join(this.deps.dir, name), { force: true });
      } catch {
        // Still in use (the installer that started this Vunemi): the next start removes it.
      }
    }
  }

  /** The offer to fetch; only a signed one (with url and sha256) is ever fetched. */
  prepare(offer: Offer): void {
    this.offer = offer;
    this.staged = null;
  }

  setFeedURL(): void {
    // The feed was read already; the offer says what to download.
  }

  checkForUpdates(): void {
    const offer = this.offer;
    if (!offer?.url || !offer.sha256) return void this.fail("no signed installer was offered");
    void this.fetch(offer.url, offer.version, offer.sha256);
  }

  private async fetch(url: string, version: string, expected: string): Promise<void> {
    mkdirSync(this.deps.dir, { recursive: true });
    const file = join(this.deps.dir, `Vunemi-Setup-${version}-${this.deps.arch}.exe`);
    const part = `${file}.part`;
    try {
      rmSync(part, { force: true });
      await this.deps.download(url, part);
      if ((await sha256(part)) !== expected) throw new Error("the downloaded installer is not the one the feed signed");
      renameSync(part, file);
      this.staged = { file, sha256: expected };
      for (const listener of this.downloaded) listener();
    } catch (err) {
      rmSync(part, { force: true });
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** True only while the staged installer is still exactly the checked one. */
  async stagedMatches(): Promise<boolean | null> {
    if (!this.staged) return null;
    try {
      if ((await sha256(this.staged.file)) === this.staged.sha256) return true;
    } catch {
      // Gone: the same as changed.
    }
    rmSync(this.staged.file, { force: true });
    this.staged = null;
    return false;
  }

  /** Runs the checked installer and quits. Without one, nothing happens. */
  quitAndInstall(): void {
    if (!this.staged) return;
    this.deps.spawn(this.staged.file, INSTALL_ARGS);
    this.deps.quit();
  }

  on(event: "update-downloaded", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "update-downloaded" | "error", listener: (() => void) | ((error: Error) => void)): void {
    if (event === "update-downloaded") this.downloaded.push(listener as () => void);
    else this.failed.push(listener as (error: Error) => void);
  }

  private fail(message: string): void {
    for (const listener of this.failed) listener(new Error(message));
  }
}

/**
 * Whether this Vunemi can replace itself: a packaged app running from the
 * folder its installer recorded (HKCU\Software\<app id>\InstallLocation),
 * not a development run or a copy elsewhere.
 */
export function installableOnWindows(execPath: string, installLocation: string | null, packaged: boolean): boolean {
  if (!packaged || !installLocation) return false;
  // Windows' own rules, wherever this runs: "..", "/" and letter case are settled first.
  const folder = win32.resolve(installLocation).toLowerCase().replace(/\\+$/, "");
  const exe = win32.resolve(execPath).toLowerCase();
  return exe.startsWith(`${folder}\\`);
}

/** electron-builder's namespace for the installer's id (UUID v5 of the app id). */
const BUILDER_NAMESPACE = "50e065bc-3134-11e6-9bab-38c9862bdaf3";

/** The installer's registry key name for this app id: HKCU\\Software\\<this> holds InstallLocation. */
export function installerKey(appId: string): string {
  const namespace = Buffer.from(BUILDER_NAMESPACE.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(appId, "utf8")])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
