/**
 * Windows: the first version. Every feature that needs macOS itself is off,
 * as on Linux; the Windows counterparts come one at a time, each tested on
 * Windows before it is switched on.
 */
import type { Platform, PlatformFeatures } from "./types.js";

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
  speakAloud: false,
};

/** Where Windows builds are downloaded by hand until the app can update itself. */
export const WINDOWS_DOWNLOAD_PAGE = "https://github.com/capitansuat/vunemi/releases";

/** Said instead of deleting: nothing is removed while the Recycle Bin is not wired. */
function recycleBinUnavailable(): never {
  throw new Error("Moving to the Recycle Bin is not available on Windows yet; nothing was deleted.");
}

export const windows: Platform = {
  id: "win32",
  features: WINDOWS_FEATURES,
  downloadPage: WINDOWS_DOWNLOAD_PAGE,
  moveToTrash: () => recycleBinUnavailable(),
  trashDownload: () => recycleBinUnavailable(),
  systemRunPrograms: {},
  vaultKey: "safe-storage",
  fileSearch: "walk",
  documentText: "portable",
};
