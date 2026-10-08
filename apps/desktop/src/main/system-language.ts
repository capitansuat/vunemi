import type { Locale } from "@vunemi/i18n";

/**
 * The language macOS runs the app in.
 *
 * macOS words what it adds by itself (dictation and emoji under Edit, window
 * tiling under Window, its own dialogs) in the first language of the app's
 * AppleLanguages that the app carries. Without a say that is the Mac's
 * language, so a Turkish Vunemi on an English Mac got English items among
 * its own. System Settings has the same switch per app (Language & Region);
 * this sets it to the language chosen in Vunemi.
 *
 * macOS reads the list when the app starts: a language chosen while it runs
 * shows in those items from the next start.
 */

/** macOS's name for a language of ours, where the bare code is not it. */
const TAG: Partial<Record<Locale, string>> = { pt: "pt-BR", zh: "zh-Hans" };

/**
 * The list to hand macOS: the chosen language first, then the Mac's own. A Mac
 * that already speaks the language keeps its region ("en-GB", "pt-PT").
 */
export function appleLanguages(locale: Locale, system: readonly string[]): string[] {
  const own = system.find((tag) => tag.toLowerCase().split(/[-_]/)[0] === locale);
  const first = own ?? TAG[locale] ?? locale;
  return [first, ...system.filter((tag) => tag !== first)];
}

/** The part of Electron's systemPreferences this needs. */
export interface UserDefaults {
  getUserDefault(key: string, type: "array"): unknown;
  setUserDefault(key: string, type: "array", value: string[]): void;
  removeUserDefault(key: string): void;
}

const KEY = "AppleLanguages";

/**
 * Tells macOS the chosen language. Returns the Mac's own first language when
 * that is another one, for what should stay in it (the pages a browser asks
 * for), and null when macOS was told nothing new.
 *
 * Our entry is taken out first: what is read then is the Mac's list, not
 * last time's answer. A Mac already in the language gets no entry at all.
 */
export function followLanguage(locale: Locale, defaults: UserDefaults): string | null {
  defaults.removeUserDefault(KEY);
  const read = defaults.getUserDefault(KEY, "array");
  const system = Array.isArray(read) ? read.filter((tag): tag is string => typeof tag === "string") : [];
  const wanted = appleLanguages(locale, system);
  if (wanted.every((tag, i) => tag === system[i])) return null;
  defaults.setUserDefault(KEY, "array", wanted);
  // Without the script: Chromium knows "zh-TW", not "zh-Hant-TW".
  return system[0]?.replace(/-[A-Za-z]{4}(?=-|$)/, "") ?? null;
}
