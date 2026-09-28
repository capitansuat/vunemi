/**
 * Vunemi's words, in the user's language.
 *
 * One catalogue per language. Turkish is the source: every other catalogue
 * is typed against it, so a key missing from a translation does not compile
 * rather than showing up blank on someone's screen.
 *
 * The same module runs in the main process and the window. Each keeps its
 * own current language; main is told by the settings, the window by main.
 * Nothing here reads the system: which language is current is a setting.
 *
 * Strings are looked up when they are shown, never at import time — a label
 * resolved when a module loaded would stay in the language of that moment.
 */

import { messages as tr } from "./messages/tr.js";
import { messages as en } from "./messages/en.js";
import { messages as de } from "./messages/de.js";
import { messages as fr } from "./messages/fr.js";
import { messages as es } from "./messages/es.js";
import { messages as it } from "./messages/it.js";
import { messages as pt } from "./messages/pt.js";
import { messages as ru } from "./messages/ru.js";
import { messages as zh } from "./messages/zh.js";
import { messages as ja } from "./messages/ja.js";
import { messages as ko } from "./messages/ko.js";
import type { Catalogue, MessageKey, PluralForms } from "./types.js";

export type { Catalogue, MessageKey, PluralForms } from "./types.js";

export interface LocaleInfo {
  code: Locale;
  /** The language's name in itself, as the picker shows it. */
  name: string;
  /** Its English name, for telling a model which language to answer in. */
  english: string;
  /** BCP 47 tag for dates and numbers. */
  tag: string;
}

export const LOCALES = [
  { code: "tr", name: "Türkçe", english: "Turkish", tag: "tr-TR" },
  { code: "en", name: "English", english: "English", tag: "en-GB" },
  { code: "de", name: "Deutsch", english: "German", tag: "de-DE" },
  { code: "fr", name: "Français", english: "French", tag: "fr-FR" },
  { code: "es", name: "Español", english: "Spanish", tag: "es-ES" },
  { code: "it", name: "Italiano", english: "Italian", tag: "it-IT" },
  { code: "pt", name: "Português", english: "Portuguese", tag: "pt-BR" },
  { code: "ru", name: "Русский", english: "Russian", tag: "ru-RU" },
  { code: "zh", name: "中文（简体）", english: "Simplified Chinese", tag: "zh-CN" },
  { code: "ja", name: "日本語", english: "Japanese", tag: "ja-JP" },
  { code: "ko", name: "한국어", english: "Korean", tag: "ko-KR" },
] as const satisfies readonly { code: string; name: string; english: string; tag: string }[];

export type Locale = (typeof LOCALES)[number]["code"];

const CATALOGUES: Record<Locale, Catalogue> = { tr, en, de, fr, es, it, pt, ru, zh, ja, ko };

let current: Locale = "tr";
const listeners = new Set<(locale: Locale) => void>();

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.some((l) => l.code === value);
}

/** The supported language closest to one of these tags ("de-AT" → "de"), or null. */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return null;
}

export function getLocale(): Locale {
  return current;
}

export function localeInfo(code: Locale = current): LocaleInfo {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0];
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  for (const listener of listeners) listener(locale);
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Vars = Record<string, string | number>;

/**
 * The text for `key` in the current language, with `{name}` placeholders
 * filled from `vars`. A plural entry is chosen by `vars.count`.
 */
export function t(key: MessageKey, vars?: Vars): string {
  return tIn(current, key, vars);
}

/** The same in a given language, for text that follows its content (a meeting's), not the app. */
export function tIn(locale: Locale, key: MessageKey, vars?: Vars): string {
  const entry = lookup(CATALOGUES[locale], key) ?? lookup(CATALOGUES.en, key) ?? lookup(CATALOGUES.tr, key);
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : pluralOf(entry, Number(vars?.count ?? 0), locale);
  return vars ? fill(text, vars) : text;
}

/** For keys built at run time, like a tool's name: is there a text for it? */
export function has(key: string): key is MessageKey {
  return lookup(CATALOGUES.tr, key) !== undefined;
}

function lookup(catalogue: Catalogue, key: string): string | PluralForms | undefined {
  let at: unknown = catalogue;
  for (const part of key.split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === "string" || (at !== null && typeof at === "object" && "other" in at) ? (at as string | PluralForms) : undefined;
}

function pluralOf(forms: PluralForms, count: number, locale: Locale): string {
  const rule = new Intl.PluralRules(localeInfo(locale).tag).select(count) as keyof PluralForms;
  return forms[rule] ?? forms.other;
}

function fill(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

/** Dates and times in the current language. */
export function formatDate(at: number | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(localeInfo().tag, options).format(at);
}

/** Lower-casing by the current language's rules (Turkish I/ı, for one). */
export function lower(text: string): string {
  return text.toLocaleLowerCase(localeInfo().tag);
}
