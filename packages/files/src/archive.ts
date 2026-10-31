/**
 * Making and opening archives with the bsdtar every Mac already has.
 *
 * An archive from the internet is someone else's file parsed by a large C
 * library, so bsdtar runs in a sandbox: no network, the user's folders closed,
 * and writing allowed only into a job folder of its own. What it made reaches
 * the user's folder only after it finished without an error, because a failed
 * run leaves things behind that look real (a damaged archive's partial file, an
 * encrypted member's zero-filled placeholder).
 *
 * A success here means bsdtar reported no error, not that the contents are
 * sound: libarchive does not check every RAR's stored data, and neither does it
 * notice all damage in a few other formats. Nothing built on this may call the
 * result verified.
 */
import { execFile } from "node:child_process";
import { chmodSync, constants, copyFileSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { t } from "@vunemi/i18n";

const exec = promisify(execFile);

const BSDTAR = "/usr/bin/bsdtar";
const XATTR = "/usr/bin/xattr";
const QUARANTINE = "com.apple.quarantine";
const TIMEOUT_MS = 15 * 60_000;
/** Left free for the rest of the Mac. */
const RESERVE_BYTES = 2 * 1024 ** 3;
/** What an archive may unpack to beyond what it claims: claims are rounded, and folders take room. */
const CLAIM_SLACK_BYTES = 256 * 1024 ** 2;
const MAX_ENTRIES = 200_000;
const WATCH_MS = 1_000;
const STALE_JOB_MS = 24 * 60 * 60_000;
/**
 * Given instead of asking: without one, bsdtar prompts for a password on a
 * terminal if there is one, and keeps trying. A locked archive then fails at
 * once, and no real password ever reaches a command line.
 */
const NO_PASSWORD = ["--passphrase", "-"];

/** bsdtar reads many more; each one left out is parser nobody here asked for. */
const OPENS = /\.(zip|7z|rar|tar|tgz|tbz|tbz2|txz|tar\.gz|tar\.bz2|tar\.xz)$/i;
const MAKES = /\.(zip|7z|tar|tgz|tbz|tbz2|txz|tar\.gz|tar\.bz2|tar\.xz)$/i;
/** Joining the parts ourselves gave wrong contents with no error when they were out of order. */
const SPLIT_RAR = /\.part\d+\.rar$/i;

export interface IsolatedRun {
  /** The only folder the program may write to. */
  job: string;
  /** What it may read besides that. */
  reads: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type IsolatedRunner = (program: string, args: readonly string[], run: IsolatedRun) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ArchiveTools {
  run: IsolatedRunner;
  /** Vunemi's own folder for job folders; never inside a folder the user sees. */
  workDir: string;
}

export interface ArchiveListing {
  names: string[];
  files: number;
  bytes: number;
}

export const isArchive = (path: string): boolean => OPENS.test(path);
export const canMake = (path: string): boolean => MAKES.test(path);
export const isSplitRar = (path: string): boolean => SPLIT_RAR.test(path);
const isRar = (path: string): boolean => /\.rar$/i.test(path);

/** "yedek.tar.gz" without the part that says what kind of archive it is. */
export function archiveStem(path: string): string {
  return basename(path).replace(OPENS, "") || "archive";
}

export function archiveProblem(file: string): string | null {
  if (isSplitRar(file)) return t("files.archiveSplit", { name: basename(file) });
  if (!isArchive(file)) return t("files.archiveUnsupported", { name: basename(file) });
  return null;
}

function jobIn(workDir: string): string {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(workDir)) {
    // A crash leaves its job behind; nothing else clears it.
    const old = join(workDir, name);
    try {
      if (Date.now() - statSync(old).mtimeMs > STALE_JOB_MS) remove(old);
    } catch {
      // Another run's, or already gone.
    }
  }
  return mkdtempSync(join(realpathSync.native(workDir), "job-"));
}

/** Clears a tree an archive may have made unreadable. Never throws: it runs while another error is on its way. */
function remove(path: string): void {
  try {
    normalise(path);
  } catch {
    // Whatever could not be repaired is left for rmSync to report silently.
  }
  rmSync(path, { recursive: true, force: true });
}

/** One line of `bsdtar -tv`: mode, links, owner, group, size, three date fields, name. */
const LISTED = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s(.*)$/;

export function parseListing(stdout: string): ArchiveListing {
  const listing: ArchiveListing = { names: [], files: 0, bytes: 0 };
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const match = LISTED.exec(line);
    if (!match) {
      // An owner with a space in its name: still an entry, of unknown size.
      listing.files += 1;
      continue;
    }
    if (match[1] !== "d") listing.files += 1;
    listing.bytes += Number(match[2]);
    listing.names.push(match[3]!);
  }
  return listing;
}

export async function listArchive(tools: ArchiveTools, input: string, signal?: AbortSignal): Promise<ArchiveListing> {
  const file = realpathSync.native(input);
  const job = jobIn(tools.workDir);
  try {
    const result = await tools.run(BSDTAR, ["-tvf", file, ...NO_PASSWORD], { job, reads: [file], signal, timeoutMs: TIMEOUT_MS });
    if (result.code !== 0) throw new Error(t("files.archiveFailed", { name: basename(file) }));
    return parseListing(result.stdout);
  } finally {
    remove(job);
  }
}

/**
 * Takes away what an archive could set that nobody chose: unreadable files and
 * folders, setuid bits, devices, and links that lead out of it. Returns what is
 * left, for comparing against what the archive claimed.
 */
function normalise(top: string): { files: number; bytes: number; dropped: number } {
  const totals = { files: 0, bytes: 0, dropped: 0 };
  const walk = (folder: string) => {
    chmodSync(folder, (lstatSync(folder).mode & 0o777) | 0o700);
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const inside = relative(top, resolve(dirname(path), target));
        if (isAbsolute(target) || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
          unlinkSync(path);
          totals.dropped += 1;
        }
      } else if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        chmodSync(path, (stat.mode & 0o777) | 0o600);
        totals.files += 1;
        totals.bytes += stat.size;
      } else {
        unlinkSync(path);
        totals.dropped += 1;
      }
    }
  };
  walk(top);
  return totals;
}

/** macOS warns before opening a downloaded app; bsdtar would drop that mark, Finder's own unpacking keeps it. */
async function keepQuarantine(from: string, folder: string): Promise<void> {
  let mark: string;
  try {
    mark = (await exec(XATTR, ["-p", QUARANTINE, from])).stdout.trim();
  } catch {
    return; // The archive has none.
  }
  if (mark) await exec(XATTR, ["-r", "-s", "-w", QUARANTINE, mark, folder]);
}

function freeBytes(path: string): number {
  const stat = statfsSync(path);
  return stat.bavail * stat.bsize;
}

function settleFolder(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
}

function settleFile(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(t("files.exists", { path: basename(to) }));
    if (code !== "EXDEV") throw error;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
}

export interface Extracted {
  files: number;
  bytes: number;
  /** Links leading out of the archive, and devices, that were not kept. */
  dropped: number;
  /** RAR damage can pass without an error. */
  unchecked: boolean;
}

export interface ExtractOptions {
  /** For tests; otherwise what the archive claims, with some slack. */
  capBytes?: number;
  watchMs?: number;
  signal?: AbortSignal;
}

/** Opens the archive into `target`, which must not exist yet. All of it, or nothing. */
export async function extractArchive(tools: ArchiveTools, input: string, target: string, options: ExtractOptions = {}): Promise<Extracted> {
  const problem = archiveProblem(input);
  if (problem) throw new Error(problem);
  const file = realpathSync.native(input);
  const name = basename(file);
  const listing = await listArchive(tools, file, options.signal);
  if (listing.files > MAX_ENTRIES) throw new Error(t("files.archiveTooBig", { name }));

  const job = jobIn(tools.workDir);
  try {
    const workDir = tools.workDir;
    const free = freeBytes(workDir);
    if (listing.bytes > free - RESERVE_BYTES) throw new Error(t("files.archiveTooBig", { name }));
    const cap = options.capBytes ?? Math.max(listing.bytes * 1.2, listing.bytes + CLAIM_SLACK_BYTES);

    const out = join(job, "out");
    mkdirSync(out);
    // A header can lie about sizes, so the claim above is not the whole check.
    const stop = new AbortController();
    let oversize = false;
    const watch = setInterval(() => {
      const now = freeBytes(workDir);
      if (free - now > cap || now < RESERVE_BYTES) {
        oversize = true;
        stop.abort();
      }
    }, options.watchMs ?? WATCH_MS);
    let code: number;
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
      code = (
        await tools.run(BSDTAR, ["-xof", file, ...NO_PASSWORD, "--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags", "--no-same-permissions", "-C", out], { job, reads: [file], signal, timeoutMs: TIMEOUT_MS })
      ).code;
    } catch (error) {
      if (oversize) throw new Error(t("files.archiveLied", { name }));
      throw error;
    } finally {
      clearInterval(watch);
    }
    if (oversize) throw new Error(t("files.archiveLied", { name }));
    if (code !== 0) throw new Error(t("files.archiveFailed", { name }));

    const made = normalise(out);
    if (made.bytes > cap) throw new Error(t("files.archiveLied", { name }));
    await keepQuarantine(file, out);

    // A zip of one folder opens as that folder, not as a folder in a folder.
    const top = readdirSync(out);
    const only = top.length === 1 ? join(out, top[0]!) : null;
    settleFolder(only && lstatSync(only).isDirectory() ? only : out, target);
    return { files: made.files, bytes: made.bytes, dropped: made.dropped, unchecked: isRar(file) };
  } finally {
    remove(job);
  }
}

/** Makes `target` from the named files and folders; links inside them stay links and are not followed. */
export async function compressToArchive(tools: ArchiveTools, inputs: readonly string[], target: string, signal?: AbortSignal): Promise<{ bytes: number }> {
  if (!canMake(target)) throw new Error(t("files.archiveWriteUnsupported"));
  const sources = inputs.map((path) => realpathSync.native(path));
  const job = jobIn(tools.workDir);
  try {
    const kind = basename(target).match(MAKES)![0]!.toLowerCase();
    const stage = join(job, `archive${kind}`);
    const format = kind === ".zip"
      // Without this mark, Windows shows the Turkish letters in a zip's names as garbage.
      ? ["--format", "zip", "--options", "zip:hdrcharset=UTF-8"]
      : kind === ".7z"
        ? ["--format", "7zip"]
        // Tar keeps the owner's account name; the person receiving it has no use for that.
        : ["-a", "--uid", "0", "--gid", "0", "--uname", "", "--gname", ""];
    // "./" keeps a name starting with "-" or "@" from being read as an option
    // or an archive to include; -s takes it off again inside the archive.
    const entries = sources.flatMap((path) => ["-C", dirname(path), `./${basename(path)}`]);
    const args = ["-cf", stage, "--no-mac-metadata", "--exclude", ".DS_Store", "-s", ",^\\./,,", ...format, ...entries];
    const { code } = await tools.run(BSDTAR, args, { job, reads: sources, signal, timeoutMs: TIMEOUT_MS });
    if (code !== 0) throw new Error(t("files.compressFailed"));
    const bytes = statSync(stage).size;
    settleFile(stage, target);
    return { bytes };
  } finally {
    remove(job);
  }
}
