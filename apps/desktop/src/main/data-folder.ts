/**
 * The data folder under the app's current name, and the one-time move from
 * the folder an earlier build used (`@ocak/desktop`, named after the package).
 *
 * The move is a rename on the same disk: instant whatever the size of the
 * models inside, and undone by renaming back. A link is left at the old path
 * so what was saved with an absolute path (undo copies, pictures) is still
 * found. Nothing is copied or deleted.
 */
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export const DATA_FOLDER = "Vunemi";

export type LegacyMove = "moved" | "none" | "kept" | "busy";

/** The folder earlier builds kept their data in. */
export function legacyDataFolder(appData: string): string {
  return join(appData, "@ocak", "desktop");
}

/**
 * Moves the earlier build's data to `target`, once.
 * - "kept": `target` already exists; nothing is touched.
 * - "none": there is nothing to move.
 * - "busy": the earlier build is running from it; moving would split its data.
 */
export function moveLegacyData(
  legacy: string,
  target: string,
  alive: (pid: number) => boolean = processAlive,
): LegacyMove {
  if (existsSync(target)) return "kept";
  let stat;
  try {
    stat = lstatSync(legacy);
  } catch {
    return "none";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "none";
  if (runningFrom(legacy, alive)) return "busy";
  renameSync(legacy, target);
  symlinkSync(target, legacy);
  return "moved";
}

/** Chromium's single-instance lock: a link whose target is "<host>-<pid>". */
function runningFrom(folder: string, alive: (pid: number) => boolean): boolean {
  let target: string;
  try {
    target = readlinkSync(join(folder, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
