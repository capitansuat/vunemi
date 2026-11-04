/**
 * Linux: the first version. Everything that needs macOS itself (its apps,
 * EventKit, the Swift helpers, Keychain, the meeting recorder, sandbox-exec)
 * is off here, and the window says so.
 */
import { existsSync } from "node:fs";
import { freedesktopMoveToTrash } from "./freedesktop-trash.js";
import type { AllowedProgram, Platform, PlatformFeatures } from "./types.js";

export const LINUX_FEATURES: PlatformFeatures = {
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

/** Where Linux builds are downloaded by hand until the app can update itself. */
export const LINUX_DOWNLOAD_PAGE = "https://github.com/capitansuat/vunemi/releases";

/**
 * The converters system_run offers on Linux: the distribution's own copies,
 * found where packages install them. Neither can fetch or execute anything
 * once the scheme and option guards in the files package have run.
 */
export const LINUX_PROGRAMS: Readonly<Record<string, AllowedProgram>> = {
  pdftotext: { path: "/usr/bin/pdftotext", what: "extract text from PDFs" },
  ffmpeg: { path: "/usr/bin/ffmpeg", what: "convert audio and video" },
};

export const linux: Platform = {
  id: "linux",
  features: LINUX_FEATURES,
  downloadPage: LINUX_DOWNLOAD_PAGE,
  moveToTrash: (path) => freedesktopMoveToTrash(path),
  trashDownload(path) {
    // Already gone (moved or trashed by the user): nothing to take back.
    if (existsSync(path)) freedesktopMoveToTrash(path);
  },
  systemRunPrograms: LINUX_PROGRAMS,
  vaultKey: "safe-storage",
  fileSearch: "walk",
  documentText: "portable",
};
