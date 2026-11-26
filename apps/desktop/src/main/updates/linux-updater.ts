/**
 * Updates on Linux, for the AppImage only, behind the same Updater interface
 * Squirrel.Mac and WindowsUpdater fill. The offer has already been read with
 * suspicion (feed.ts: the releases' own address, the maintainer's Linux
 * signature over version, architecture and SHA-256). This downloads that
 * AppImage beside the running one, keeps it only when its SHA-256 is the
 * signed one, checks it again before it is used, then renames it over the
 * running AppImage and starts it once this Vunemi has quit. A .deb can't
 * replace itself without root, so it never gets here. Nothing here is
 * reachable from the agent.
 */
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, createReadStream, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Offer } from "./feed.js";
import type { Updater } from "./service.js";

export interface LinuxUpdaterDeps {
  /** The running AppImage, as installableAppImage found it: the only file this replaces. */
  appImage: string;
  download(url: string, file: string): Promise<void>;
  /** Starts this file once the running Vunemi has quit (it holds the single-instance lock until then). */
  restart(file: string): void;
  quit(): void;
}

/** Our own files beside the AppImage: a download under way, or one checked and waiting. */
const LEFTOVER = /^\.Vunemi-.+\.AppImage\.(part|new)$/;

function sha256(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
  });
}

export class LinuxAppImageUpdater implements Updater {
  private offer: Offer | null = null;
  private staged: { file: string; sha256: string } | null = null;
  private readonly downloaded: (() => void)[] = [];
  private readonly failed: ((error: Error) => void)[] = [];

  constructor(private readonly deps: LinuxUpdaterDeps) {}

  private get dir(): string {
    return dirname(this.deps.appImage);
  }

  /** Downloads from an earlier run (cut short, or never installed): nothing staged outlives a restart. Other files stay. */
  forgetOld(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!LEFTOVER.test(name)) continue;
      try {
        rmSync(join(this.dir, name), { force: true });
      } catch {
        // The next start tries again.
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
    if (!offer?.url || !offer.sha256) return void this.fail("no signed AppImage was offered");
    void this.fetch(offer.url, offer.version, offer.sha256);
  }

  private async fetch(url: string, version: string, expected: string): Promise<void> {
    // Beside the AppImage, on its filesystem, so the rename that replaces it can't half-happen.
    const part = join(this.dir, `.Vunemi-${version}.AppImage.part`);
    const file = join(this.dir, `.Vunemi-${version}.AppImage.new`);
    try {
      rmSync(part, { force: true });
      await this.deps.download(url, part);
      if ((await sha256(part)) !== expected) throw new Error("the downloaded AppImage is not the one the feed signed");
      chmodSync(part, 0o755);
      renameSync(part, file);
      this.staged = { file, sha256: expected };
      for (const listener of this.downloaded) listener();
    } catch (err) {
      rmSync(part, { force: true });
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** True only while the staged AppImage is still exactly the checked one. */
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

  /**
   * Puts the checked AppImage in the running one's place, starts it after
   * this Vunemi quits, and quits. The running copy keeps its open file until
   * it exits. Without a staged file, or if the rename fails, nothing happens
   * but an error.
   */
  quitAndInstall(): void {
    if (!this.staged) return;
    try {
      renameSync(this.staged.file, this.deps.appImage);
    } catch (err) {
      this.staged = null;
      return void this.fail(err instanceof Error ? err.message : String(err));
    }
    this.staged = null;
    this.deps.restart(this.deps.appImage);
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

const canWrite = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The AppImage this Vunemi may replace, or null. The AppImage runtime sets
 * APPIMAGE (the file) and APPDIR (where it is mounted); a .deb started from
 * another AppImage's terminal inherits that program's pair, so Vunemi's own
 * executable must be inside APPDIR. The file must be a regular file (not a
 * link: renaming over a link would replace the link) in a folder this user
 * can write, as in ~/Applications and not under /opt.
 */
export function installableAppImage(
  env: { APPIMAGE?: string; APPDIR?: string },
  execPath: string,
  packaged: boolean,
  writable: (dir: string) => boolean = canWrite,
): string | null {
  const file = env.APPIMAGE;
  const mount = env.APPDIR?.replace(/\/+$/, "");
  if (!packaged || !file || !mount || !isAbsolute(file) || !isAbsolute(mount)) return null;
  if (!execPath.startsWith(`${mount}/`)) return null;
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return writable(dirname(file)) ? file : null;
}

/**
 * The command that starts the new AppImage once process `pid` has gone (it
 * holds the single-instance lock until then). A child started from Node
 * inherits every open file not marked close-on-exec, among them the AppImage
 * runtime's keep-alive pipe, which keeps the old image mounted while anything
 * holds it, so the step first closes what it inherited: bash closes every
 * file above stderr; plain sh (dash) only takes single-digit descriptors, so
 * it closes 3 to 9, where the runtime's pipe arrives.
 */
export function restartCommand(pid: number, file: string, bash: boolean): [string, string[]] {
  const close = bash
    ? 'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null; '
    : "exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-; ";
  const script = `${close}while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"`;
  return [bash ? "/bin/bash" : "/bin/sh", ["-c", script, "vunemi-restart", String(pid), file]];
}
