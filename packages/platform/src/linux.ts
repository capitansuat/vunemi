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
  // The AppImage replaces itself with the signed update; a .deb is shown the download page.
  inAppUpdates: true,
  archives: false,
  atomicMove: false,
  speakAloud: false,
  // Its own whisper build (build-whisper-linux.sh), tried with a microphone.
  dictation: true,
};

/** Where a Linux build that can't replace itself (a .deb) is downloaded by hand. */
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
