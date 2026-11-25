/**
 * The last step of a durable write: after a file is written, fsynced and
 * renamed into place, its folder is fsynced so the rename itself survives a
 * power cut. macOS and Linux allow that; Windows refuses to fsync a folder
 * (EPERM) and makes a rename durable through the file's own handle, which
 * the callers have already fsynced. There the folder is only checked, so a
 * folder that vanished still fails the write instead of passing silently.
 */
import * as fs from "node:fs";

export function syncFolder(dir: string, system: NodeJS.Platform = process.platform, flags: string | number = "r"): void {
  if (system === "win32") {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
    return;
  }
  const fd = fs.openSync(dir, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
