/**
 * The Trash on Linux, as the freedesktop.org Trash specification (1.0)
 * describes it, so that a file Vunemi trashes shows up in the desktop's own
 * Trash and can be restored from there.
 *
 *  * A file on the same file system as the home Trash
 *    ($XDG_DATA_HOME/Trash, by default ~/.local/share/Trash) goes there.
 *  * A file on another file system goes to that file system's own Trash:
 *    $topdir/.Trash/$uid when an administrator made $topdir/.Trash (a real
 *    directory with the sticky bit), otherwise $topdir/.Trash-$uid.
 *  * Each trashed item has a .trashinfo file with where it was and when.
 *    The info file is created first, exclusively, which is how two trashings
 *    of the same name cannot take the same slot.
 *
 * Nothing here deletes a user's file. When no Trash can take it, the move
 * is refused and the file stays where it is. Only rename() is used, so a
 * file is never copied across file systems and then removed.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Trashed } from "./types.js";

export interface FreedesktopTrashOptions {
  /** $XDG_DATA_HOME; ~/.local/share when unset or not absolute. */
  dataHome?: string;
  /** The user's numeric id, for $topdir/.Trash-$uid. */
  uid?: number;
  /** For DeletionDate. */
  now?: () => Date;
}

export class TrashRefused extends Error {
  constructor(message: string, readonly code: "missing" | "no-trash" | "is-trash") {
    super(message);
    this.name = "TrashRefused";
  }
}

const STICKY = 0o1000;

/** $XDG_DATA_HOME, as the Base Directory spec reads it: relative values are ignored. */
export function dataHomeOf(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const value = env.XDG_DATA_HOME;
  return value && isAbsolute(value) ? value : join(home, ".local", "share");
}

/** Local time, to the second, as the spec's DeletionDate wants it (no zone). */
export function deletionDate(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/**
 * A path for the Path= key: percent-encoded like a URL path ("/" kept), so
 * that newlines and other bytes cannot break the key-value file.
 */
export function encodeTrashPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

/** The highest folder that is still on the same file system as `path`. */
export function mountTopOf(path: string): string {
  const device = lstatSync(path).dev;
  let current = resolve(path);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return current;
    if (statSync(parent).dev !== device) return current;
    current = parent;
  }
}

/** A folder Vunemi may put trashed files in: a real directory, ours or created now with 0700. */
function ownTrashDir(dir: string, uid: number | undefined, create: boolean): boolean {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if (uid !== undefined && info.uid !== uid) return false;
    return true;
  } catch {
    if (!create) return false;
    try {
      mkdirSync(dir, { mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
}

function prepare(trash: string): void {
  mkdirSync(join(trash, "files"), { recursive: true, mode: 0o700 });
  mkdirSync(join(trash, "info"), { recursive: true, mode: 0o700 });
}

/** Which Trash a file goes to, and whether its Path= is written relative to the top folder. */
export function trashFor(file: string, opts: FreedesktopTrashOptions = {}): { dir: string; top: string | null } {
  const uid = opts.uid ?? process.getuid?.();
  const home = join(opts.dataHome ?? dataHomeOf(), "Trash");
  prepare(home);
  const fileDev = lstatSync(file).dev;
  if (statSync(home).dev === fileDev) return { dir: home, top: null };

  const top = mountTopOf(file);
  if (uid === undefined) throw new TrashRefused("This system does not say which user is running Vunemi.", "no-trash");
  // An administrator's shared $topdir/.Trash: used only if it is a real, sticky directory.
  const shared = join(top, ".Trash");
  try {
    const info = lstatSync(shared);
    if (!info.isSymbolicLink() && info.isDirectory() && (info.mode & STICKY) !== 0) {
      const mine = join(shared, String(uid));
      if (ownTrashDir(mine, uid, true)) {
        prepare(mine);
        return { dir: mine, top };
      }
    }
  } catch {
    // None: fall through to .Trash-$uid.
  }
  const own = join(top, `.Trash-${uid}`);
  if (ownTrashDir(own, uid, true)) {
    prepare(own);
    return { dir: own, top };
  }
  throw new TrashRefused(`No Trash can take files from ${top}.`, "no-trash");
}

/** Reserves a name in the Trash by creating its info file exclusively. */
function reserve(trash: string, name: string, info: string): { name: string; infoPath: string } {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? name : `${stem} ${n}${ext}`;
    if (existsSync(join(trash, "files", candidate))) continue;
    const infoPath = join(trash, "info", `${candidate}.trashinfo`);
    let fd: number;
    try {
      fd = openSync(infoPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      writeSync(fd, info);
    } finally {
      closeSync(fd);
    }
    return { name: candidate, infoPath };
  }
  throw new TrashRefused("The Trash has too many items with this name.", "no-trash");
}

export function freedesktopMoveToTrash(path: string, opts: FreedesktopTrashOptions = {}): Trashed {
  const file = resolve(path);
  if (!existsSync(file) && !isLink(file)) throw new TrashRefused(`${file} does not exist.`, "missing");
  const { dir, top } = trashFor(file, opts);
  // Trashing the Trash itself, or something inside it, would lose track of it.
  const inside = relative(dir, file);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) throw new TrashRefused("That is already in the Trash.", "is-trash");
  const recorded = top ? relative(top, file) : file;
  const when = deletionDate((opts.now ?? (() => new Date()))());
  const info = `[Trash Info]\nPath=${encodeTrashPath(recorded)}\nDeletionDate=${when}\n`;
  const { name, infoPath } = reserve(dir, basename(file), info);
  const trashed = join(dir, "files", name);
  try {
    renameSync(file, trashed);
  } catch (err) {
    // Not moved: the reservation goes, the file stays where it was.
    rmSync(infoPath, { force: true });
    throw err;
  }
  return {
    path: trashed,
    restore: () => {
      if (!existsSync(trashed) || existsSync(file)) return;
      renameSync(trashed, file);
      rmSync(infoPath, { force: true });
    },
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
