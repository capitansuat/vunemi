/**
 * The move journal's lock on Windows. On macOS and Linux a helper takes
 * flock on a file the app keeps open, and the lock outlives the helper;
 * Windows lets a process's locks go when it exits, so here the app holds the
 * lock itself: the lock file opened with no sharing at all (libuv's
 * UV_FS_O_EXLOCK), which a second open, from any process, cannot get.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { JournalAdmissionError } from "@vunemi/mac";

/** libuv's exclusive-open flag; defined in fs.constants only on Windows. */
const EXLOCK = (constants as Record<string, number>).UV_FS_O_EXLOCK ?? 0x10000000;

export async function windowsJournalAdmission<T>(journalPath: string, body: (assertCurrent: () => void) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new JournalAdmissionError("stopped");
  if (!isAbsolute(journalPath)) throw new JournalAdmissionError("journal-unavailable");
  let fd: number;
  let path: string;
  try {
    mkdirSync(dirname(journalPath), { recursive: true });
    path = join(realpathSync.native(dirname(journalPath)), `${basename(journalPath)}.lock`);
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | EXLOCK, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new JournalAdmissionError(code === "EBUSY" || code === "EPERM" || code === "EACCES" ? "journal-busy" : "journal-unavailable", error);
  }
  try {
    const held = fstatSync(fd, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n) throw new JournalAdmissionError("journal-unavailable");
    const assertCurrent = () => {
      const now = lstatSync(path, { bigint: true });
      const open = fstatSync(fd, { bigint: true });
      if (now.isSymbolicLink() || !now.isFile() || now.dev !== held.dev || now.ino !== held.ino || open.ino !== held.ino || now.nlink !== 1n) {
        throw Object.assign(new Error("Journal admission identity changed."), { reasonCode: "journal-unavailable" });
      }
    };
    assertCurrent();
    if (signal?.aborted) throw new JournalAdmissionError("stopped");
    return await body(assertCurrent);
  } finally {
    closeSync(fd);
  }
}
