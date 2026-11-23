/**
 * The Recycle Bin on Windows, done the way Explorer keeps it, so a file
 * Vunemi trashes shows up in the Recycle Bin and can be restored from there.
 *
 *  * Each volume has `<root>\$Recycle.Bin\<user SID>`. Windows makes that
 *    folder; Vunemi only uses it when it is already there as a real folder.
 *  * A trashed item is renamed to `$R` + six random characters + its
 *    extension, next to a `$I` file with the same suffix that records where
 *    it was, its size and when it was deleted (version 2 of the format).
 *  * The `$I` file is created first, exclusively, which reserves the slot.
 *
 * Nothing here deletes a user's file. The shell's own "delete to the Recycle
 * Bin" call is not used: from a process without a desktop (as over SSH) it
 * deletes for good, without a word. Only rename is used, so a file on
 * another volume is refused and stays where it is, never copied and removed.
 */
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, parse, relative, resolve, isAbsolute } from "node:path";
import type { Trashed } from "./types.js";

export interface WindowsRecycleOptions {
  /** The bin folder a path goes to; by default its volume's `$Recycle.Bin\<SID>`. */
  binFor?: (path: string) => string;
  /** The user's SID, for the default bin folder. */
  sid?: string;
  /** For the deletion time in the `$I` record. */
  now?: () => Date;
}

export class RecycleRefused extends Error {
  constructor(message: string, readonly code: "missing" | "no-bin" | "is-bin" | "taken") {
    super(message);
    this.name = "RecycleRefused";
  }
}

/** 100-nanosecond steps between 1601-01-01 (FILETIME's start) and 1970-01-01. */
const EPOCH_DIFF_MS = 11_644_473_600_000n;
const SLOT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** The `$I` record, version 2: version, size, deletion FILETIME, path length (UTF-16 units with the NUL), path + NUL. */
export function recycleInfo(path: string, size: bigint, at: Date): Buffer {
  const name = Buffer.from(`${path}\0`, "utf16le");
  const head = Buffer.alloc(28);
  head.writeBigInt64LE(2n, 0);
  head.writeBigInt64LE(size, 8);
  head.writeBigInt64LE((BigInt(at.getTime()) + EPOCH_DIFF_MS) * 10_000n, 16);
  head.writeInt32LE(name.length / 2, 24);
  return Buffer.concat([head, name]);
}

/** Reads a `$I` record, version 2 or the older version 1 (a fixed 260-character path). */
export function readRecycleInfo(buffer: Buffer): { path: string; size: bigint; deletedAt: Date } {
  const version = buffer.readBigInt64LE(0);
  const size = buffer.readBigInt64LE(8);
  const deletedAt = new Date(Number(buffer.readBigInt64LE(16) / 10_000n - EPOCH_DIFF_MS));
  let raw: string;
  if (version === 2n) raw = buffer.subarray(28, 28 + buffer.readInt32LE(24) * 2).toString("utf16le");
  else if (version === 1n) raw = buffer.subarray(24, 24 + 520).toString("utf16le");
  else throw new Error(`Unknown Recycle Bin record version ${version}.`);
  const end = raw.indexOf("\0");
  return { path: end >= 0 ? raw.slice(0, end) : raw, size, deletedAt };
}

let cachedSid: string | undefined;
/** The SID of the user running Vunemi, asked of Windows once. */
function currentSid(): string {
  if (cachedSid) return cachedSid;
  let out = "";
  try {
    out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  } catch {
    // No answer: no bin can be named, so nothing moves.
  }
  const sid = /S-1-[0-9-]+/.exec(out)?.[0];
  if (!sid) throw new RecycleRefused("Windows did not say which user is running Vunemi.", "no-bin");
  cachedSid = sid;
  return sid;
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(folder.toLowerCase(), path.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Bytes in a file, or in everything under a folder (links not followed). */
function sizeOf(path: string): bigint {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory()) return info.size;
  let total = 0n;
  for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
  return total;
}

/** Reserves a slot by creating its `$I` record exclusively. */
function reserve(bin: string, ext: string, record: Buffer): { slot: string; info: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += SLOT[randomInt(SLOT.length)];
    const slot = join(bin, `$R${suffix}${ext}`);
    const info = join(bin, `$I${suffix}${ext}`);
    if (existsSync(slot)) continue;
    let fd: number;
    try {
      fd = openSync(info, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      writeSync(fd, record);
    } finally {
      closeSync(fd);
    }
    return { slot, info };
  }
  throw new RecycleRefused("The Recycle Bin has no free name for this item.", "no-bin");
}

export function windowsMoveToTrash(path: string, opts: WindowsRecycleOptions = {}): Trashed {
  const given = resolve(path);
  let real: string;
  try {
    // The folder's real path, the item's own name: a link is trashed as the link.
    real = join(realpathSync.native(dirname(given)), basename(given));
    lstatSync(real);
  } catch {
    throw new RecycleRefused(`${given} does not exist.`, "missing");
  }
  const bin = opts.binFor ? opts.binFor(real) : join(parse(real).root, "$Recycle.Bin", opts.sid ?? currentSid());
  // Trashing the bin, or something already in a bin, would lose track of it.
  if (isInside(real, bin) || isInside(bin, real) || real.toLowerCase().split(/[\\/]/).includes("$recycle.bin")) {
    throw new RecycleRefused("That is already in the Recycle Bin.", "is-bin");
  }
  try {
    const info = lstatSync(bin);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("not a folder");
  } catch {
    throw new RecycleRefused(`There is no Recycle Bin folder for ${parse(real).root || real}.`, "no-bin");
  }
  const folder = lstatSync(real).isDirectory();
  const record = recycleInfo(real, sizeOf(real), (opts.now ?? (() => new Date()))());
  const { slot, info } = reserve(bin, folder ? "" : extname(real), record);
  try {
    renameSync(real, slot);
  } catch (err) {
    // Not moved (another volume, or in use): the reservation goes, the item stays.
    rmSync(info, { force: true });
    throw new RecycleRefused(`Windows could not move ${real} to the Recycle Bin: ${(err as Error).message}`, "no-bin");
  }
  return {
    path: slot,
    restore: () => {
      if (existsSync(real)) throw new RecycleRefused(`Something new is at ${real}; the trashed one stays in the Recycle Bin.`, "taken");
      if (folder) {
        // Windows' rename puts a folder over a file without a word (seen in
        // the VM), so the place is claimed first: mkdir fails if anything is
        // there, even if it appeared after the check above. The contents then
        // move into the new, empty folder, and the empty slot goes.
        try {
          mkdirSync(real);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new RecycleRefused(`Something new is at ${real}.`, "taken");
          throw err;
        }
        for (const entry of readdirSync(slot)) renameSync(join(slot, entry), join(real, entry));
        rmdirSync(slot);
      } else {
        // A link fails if a file appeared meanwhile, where a rename would replace it.
        try {
          linkSync(slot, real);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new RecycleRefused(`Something new is at ${real}.`, "taken");
          throw err;
        }
        unlinkSync(slot);
      }
      // As Explorer does when it restores: the record goes with the item.
      rmSync(info, { force: true });
    },
  };
}
