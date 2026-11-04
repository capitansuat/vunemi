import { darwin } from "./darwin.js";
import { linux } from "./linux.js";
import type { Platform, PlatformId, PlatformInfo } from "./types.js";

export * from "./types.js";
export { darwin, DARWIN_FEATURES, DARWIN_PROGRAMS, darwinMoveToTrash, uniqueIn } from "./darwin.js";
export { linux, LINUX_FEATURES, LINUX_DOWNLOAD_PAGE, LINUX_PROGRAMS } from "./linux.js";
export { dataHomeOf, deletionDate, encodeTrashPath, freedesktopMoveToTrash, mountTopOf, trashFor, TrashRefused, type FreedesktopTrashOptions } from "./freedesktop-trash.js";

/**
 * The implementation for a Node platform name. Vunemi is built for macOS and
 * Linux; anything else gets Linux's, which assumes the least about the system.
 */
export function platformFor(name: NodeJS.Platform | string): Platform {
  return name === "darwin" ? darwin : linux;
}

/** The system this process runs on. */
export const platform: Platform = platformFor(process.platform);

/** What may cross to the window: no functions. */
export function platformInfo(p: Platform = platform): PlatformInfo {
  return { id: p.id, features: { ...p.features }, downloadPage: p.downloadPage };
}

export function isPlatformId(value: unknown): value is PlatformId {
  return value === "darwin" || value === "linux";
}
