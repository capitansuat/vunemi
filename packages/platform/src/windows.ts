/**
 * Windows: the first version. Every feature that needs macOS itself is off,
 * as on Linux; the Windows counterparts come one at a time, each tested on
 * Windows before it is switched on.
 */
import { existsSync } from "node:fs";
import type { Platform, PlatformFeatures } from "./types.js";
import { windowsMoveToTrash } from "./windows-recycle.js";

export const WINDOWS_FEATURES: PlatformFeatures = {
  macApps: false,
  shortcuts: false,
  desktopControl: false,
  systemCalendar: false,
  appleMail: false,
  meetings: false,
  appLock: false,
  backgroundRecipes: false,
  addons: false,
  inAppUpdates: false,
  archives: false,
  atomicMove: false,
  speakAloud: true,
};

/** Where Windows builds are downloaded by hand until the app can update itself. */
export const WINDOWS_DOWNLOAD_PAGE = "https://github.com/capitansuat/vunemi/releases";


export const windows: Platform = {
  id: "win32",
  features: WINDOWS_FEATURES,
  downloadPage: WINDOWS_DOWNLOAD_PAGE,
  moveToTrash: (path) => windowsMoveToTrash(path),
  trashDownload(path) {
    // Already gone (moved or deleted by the user): nothing to take back.
    if (existsSync(path)) windowsMoveToTrash(path);
  },
  systemRunPrograms: {},
  vaultKey: "safe-storage",
  fileSearch: "walk",
  documentText: "portable",
};
