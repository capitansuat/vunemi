/**
 * What differs between the systems Vunemi runs on, in one place.
 *
 * The rest of the app asks this module instead of reading process.platform:
 * a feature is either here or it is not, and the window is told which, so it
 * can say "not on Linux yet" rather than offer something that fails.
 */

export type PlatformId = "darwin" | "linux";

/**
 * Parts of Vunemi that exist on one system only. `true` means the feature is
 * offered; `false` means it is hidden or shown as unavailable.
 */
export interface PlatformFeatures {
  /** Mac apps through their scripting dictionaries: Notes, Finder, Office, Music, Photos, Messages… */
  macApps: boolean;
  /** The Shortcuts app. */
  shortcuts: boolean;
  /** Seeing and clicking the screen through the signed Swift helper. */
  desktopControl: boolean;
  /** Calendar and Reminders through EventKit. */
  systemCalendar: boolean;
  /** Accounts set up in Apple Mail. */
  appleMail: boolean;
  /** Recording and writing down meetings. */
  meetings: boolean;
  /** The optional app lock (Touch ID or the login password). */
  appLock: boolean;
  /** Recipes that drive a Mac app in the background. */
  backgroundRecipes: boolean;
  /** Downloadable add-ons: they run in macOS's sandbox. */
  addons: boolean;
  /** The updater that downloads and installs a new version itself. */
  inAppUpdates: boolean;
  /** files_move: needs the helper's atomic, no-overwrite move. */
  atomicMove: boolean;
  /** Reading answers aloud with the system's own voices. */
  speakAloud: boolean;
}

export const FEATURE_IDS = [
  "macApps",
  "shortcuts",
  "desktopControl",
  "systemCalendar",
  "appleMail",
  "meetings",
  "appLock",
  "backgroundRecipes",
  "addons",
  "inAppUpdates",
  "atomicMove",
  "speakAloud",
] as const satisfies readonly (keyof PlatformFeatures)[];

export type FeatureId = (typeof FEATURE_IDS)[number];

/** What the window is told about the system it runs on. */
export interface PlatformInfo {
  id: PlatformId;
  features: PlatformFeatures;
  /** Where a new version is downloaded by hand, when the app does not update itself. */
  downloadPage: string | null;
}

/** Something moved to the Trash, and how to put it back. */
export interface Trashed {
  /** Where it is now. */
  path: string;
  /** Puts it back where it was, if that place is still free. Never overwrites. */
  restore(): void;
}

/** A program `system_run` may start, by name. */
export interface AllowedProgram {
  path: string;
  what: string;
}

export interface Platform extends PlatformInfo {
  /**
   * Moves a file or folder to the user's Trash. Never deletes: when it cannot
   * be moved there, it throws and the file stays where it was.
   */
  moveToTrash(path: string): Trashed;
  /**
   * A finished download taken back from the activity log. Kept apart from
   * moveToTrash because macOS has always done this one by the file's own
   * name and only when that name is free in the Trash.
   */
  trashDownload(path: string, name: string): void;
  /** The converters system_run offers. */
  systemRunPrograms: Readonly<Record<string, AllowedProgram>>;
  /** How the Vault's key is kept: the signed Keychain helper, or Electron's safeStorage. */
  vaultKey: "keychain-helper" | "safe-storage";
  /** How files_search finds files: Spotlight, or by walking the open folders. */
  fileSearch: "spotlight" | "walk";
}
