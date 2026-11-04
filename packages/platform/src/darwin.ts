/**
 * macOS: what Vunemi has always done there. The code paths below are the
 * ones that used to sit inline in the files package and in main; they were
 * moved here unchanged.
 */
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AllowedProgram, Platform, PlatformFeatures, Trashed } from "./types.js";

export const DARWIN_FEATURES: PlatformFeatures = {
  macApps: true,
  shortcuts: true,
  desktopControl: true,
  systemCalendar: true,
  appleMail: true,
  meetings: true,
  appLock: true,
  backgroundRecipes: true,
  addons: true,
  inAppUpdates: true,
  atomicMove: true,
  speakAloud: true,
};

/**
 * The programs `system_run` will start. Each one converts or reads a file and
 * does nothing else; none of them can fetch, install or execute anything.
 */
export const DARWIN_PROGRAMS: Readonly<Record<string, AllowedProgram>> = {
  sips: { path: "/usr/bin/sips", what: "convert and scale images" },
  textutil: { path: "/usr/bin/textutil", what: "convert document formats" },
  qlmanage: { path: "/usr/bin/qlmanage", what: "make preview images" },
  pdftotext: { path: "/opt/homebrew/bin/pdftotext", what: "extract text from PDFs" },
  ffmpeg: { path: "/opt/homebrew/bin/ffmpeg", what: "convert audio and video" },
};

/** The Trash already has a file by that name more often than you'd think. */
export function uniqueIn(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export function darwinMoveToTrash(file: string): Trashed {
  const trashed = join(homedir(), ".Trash", uniqueIn(join(homedir(), ".Trash"), basename(file)));
  renameSync(file, trashed);
  return {
    path: trashed,
    restore: () => {
      if (existsSync(trashed) && !existsSync(file)) renameSync(trashed, file);
    },
  };
}

export const darwin: Platform = {
  id: "darwin",
  features: DARWIN_FEATURES,
  downloadPage: null,
  moveToTrash: darwinMoveToTrash,
  trashDownload(path, name) {
    const trashed = join(homedir(), ".Trash", name);
    if (existsSync(path) && !existsSync(trashed)) renameSync(path, trashed);
  },
  systemRunPrograms: DARWIN_PROGRAMS,
  vaultKey: "keychain-helper",
  fileSearch: "spotlight",
};
