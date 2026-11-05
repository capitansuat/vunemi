/**
 * The compiler already refuses a translation with a key missing. What it
 * can't see is inside the strings: a `{name}` dropped or misspelled in one
 * language shows up as a hole, or as a literal "{nmae}", on someone's screen.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LOCALES, formatDate, getSystem, has, isLocale, lower, matchLocale, onLocaleChange, setLocale, setSystem, t, getLocale } from "../src/index.js";
import type { Catalogue, SystemTexts } from "../src/types.js";
import { messages as tr, onLinux as trLinux } from "../src/messages/tr.js";
import { messages as en, onLinux as enLinux } from "../src/messages/en.js";
import { messages as de, onLinux as deLinux } from "../src/messages/de.js";
import { messages as fr, onLinux as frLinux } from "../src/messages/fr.js";
import { messages as es, onLinux as esLinux } from "../src/messages/es.js";
import { messages as it_, onLinux as itLinux } from "../src/messages/it.js";
import { messages as pt, onLinux as ptLinux } from "../src/messages/pt.js";
import { messages as ru, onLinux as ruLinux } from "../src/messages/ru.js";
import { messages as zh, onLinux as zhLinux } from "../src/messages/zh.js";
import { messages as ja, onLinux as jaLinux } from "../src/messages/ja.js";
import { messages as ko, onLinux as koLinux } from "../src/messages/ko.js";

const CATALOGUES: Record<string, Catalogue> = { en, de, fr, es, it: it_, pt, ru, zh, ja, ko };

type Entry = string | Record<string, string>;

function entries(node: unknown, prefix = ""): [string, Entry][] {
  const out: [string, Entry][] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.push([path, value]);
    else if (value && typeof value === "object" && typeof (value as { other?: unknown }).other === "string") out.push([path, value as Record<string, string>]);
    else out.push(...entries(value, path));
  }
  return out;
}

function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
}

/** Every name the entry uses, across all its plural forms. */
function namesOf(entry: Entry): Set<string> {
  const texts = typeof entry === "string" ? [entry] : Object.values(entry);
  return new Set(texts.flatMap((text) => [...placeholders(text)]));
}

afterEach(() => {
  setLocale("tr");
  setSystem("darwin");
});

const ON_LINUX: Record<string, SystemTexts> = { tr: trLinux, en: enLinux, de: deLinux, fr: frLinux, es: esLinux, it: itLinux, pt: ptLinux, ru: ruLinux, zh: zhLinux, ja: jaLinux, ko: koLinux };
const ALL: Record<string, Catalogue> = { tr: tr as Catalogue, ...CATALOGUES };

describe("the Linux wording", () => {
  it("covers the same keys in every language", () => {
    const keys = Object.keys(trLinux).sort();
    expect(keys.length).toBeGreaterThan(0);
    for (const [lang, texts] of Object.entries(ON_LINUX)) expect(Object.keys(texts).sort(), lang).toEqual(keys);
  });

  it("only replaces keys that exist, keeping their placeholders", () => {
    for (const [lang, texts] of Object.entries(ON_LINUX)) {
      const base = new Map(entries(ALL[lang]));
      for (const [key, text] of Object.entries(texts)) {
        const original = base.get(key);
        expect(typeof original, `${lang} ${key}`).toBe("string");
        expect([...placeholders(text!)].sort(), `${lang} ${key}`).toEqual([...namesOf(original!)].sort());
      }
    }
  });

  it("no longer speaks of the Mac, Finder or ⌘", () => {
    for (const [lang, texts] of Object.entries(ON_LINUX)) {
      for (const [key, text] of Object.entries(texts)) expect(text, `${lang} ${key}`).not.toMatch(/Mac|Finder|访达|⌘|キーチェーン|키체인|钥匙串/);
    }
  });

  it("is used only once the system is Linux", () => {
    setLocale("en");
    expect(getSystem()).toBe("darwin");
    expect(t("engine.setup.title")).toBe("A model for this Mac");
    setSystem("linux");
    expect(t("engine.setup.title")).toBe("A model for this computer");
    expect(t("modelsMemory.summary", { total: "16 GB", available: "9 GB" })).toBe("This computer: 16 GB · available now: 9 GB");
    // A key without a Linux wording falls through to the catalogue.
    expect(t("vault.unlock")).toBe(en.vault.unlock);
  });
});

describe("catalogues", () => {
  it('localizes outcome progress and preserves exact target interpolation in every language',()=>{
    for(const locale of LOCALES){
      setLocale(locale.code);
      for(const key of ['browserWrite','browserVerify','calendarWrite','calendarVerify','draftWrite','draftVerify']){
        const text=t(`outcomeProgress.${key}` as Parameters<typeof t>[0],{target:'Synthetic target Ω'});
        expect(text).toContain('Synthetic target Ω');expect(text).not.toContain('{target}');
        expect(text).not.toContain('outcomeProgress.');
      }
      const review=t('outcomeProgress.reviewNeeded');expect(review).not.toContain('{target}');
      if(locale.code!=='en')expect(review).not.toBe(en.outcomeProgress.reviewNeeded);
    }
  });
  const source = new Map(entries(tr));

  for (const [code, catalogue] of Object.entries(CATALOGUES)) {
    it(`${code} fills in exactly what the Turkish does`, () => {
      const wrong: string[] = [];
      for (const [key, entry] of entries(catalogue)) {
        const original = source.get(key);
        expect(original, `${code}: ${key} is not in the source`).toBeDefined();
        const want = [...namesOf(original!)].filter((n) => n !== "count").sort();
        const got = [...namesOf(entry)].filter((n) => n !== "count").sort();
        if (want.join() !== got.join()) wrong.push(`${key}: ${got.join(",")} ≠ ${want.join(",")}`);
        // A plural's "other" is the form that has to say how many.
        if (typeof entry !== "string" && namesOf(original!).has("count")) {
          if (!placeholders(entry.other ?? "").has("count")) wrong.push(`${key}: "other" has no {count}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it(`${code} is actually translated`, () => {
      // A copied Turkish string would compile and be wrong. Some are the same
      // in every language (units, product names); most must not be.
      const same = entries(catalogue).filter(([key, entry]) => {
        const original = source.get(key)!;
        return JSON.stringify(entry) === JSON.stringify(original) && /[çğıöşüÇĞİÖŞÜ]/.test(JSON.stringify(original));
      });
      expect(same.map(([key]) => key)).toEqual([]);
    });
  }

  it("has one catalogue for every language in the picker", () => {
    expect(LOCALES.map((l) => l.code).sort()).toEqual(["tr", ...Object.keys(CATALOGUES)].sort());
  });
});

describe("t", () => {
  it("fills placeholders", () => {
    setLocale("en");
    expect(t("files.preview.read", { path: "~/a.txt" })).toBe("Read: ~/a.txt");
  });

  it("chooses the plural by count and by the language's own rules", () => {
    setLocale("en");
    expect(t("turn.steps", { count: 1 })).toBe("1 step");
    expect(t("turn.steps", { count: 3 })).toBe("3 steps");
    setLocale("ru");
    expect(t("turn.steps", { count: 1 })).toBe("1 шаг");
    expect(t("turn.steps", { count: 3 })).toBe("3 шага");
    expect(t("turn.steps", { count: 5 })).toBe("5 шагов");
    expect(t("turn.steps", { count: 21 })).toBe("21 шаг");
    setLocale("ja");
    expect(t("turn.steps", { count: 1 })).toBe("1 ステップ");
  });

  it("leaves an unknown placeholder visible rather than blank", () => {
    setLocale("en");
    expect(t("files.preview.read")).toBe("Read: {path}");
  });

  it("gives the key back for a key that isn't there", () => {
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });

  it("knows which run-time keys exist", () => {
    expect(has("tools.page_click.ask")).toBe(true);
    expect(has("tools.nope.ask")).toBe(false);
    expect(has("__proto__")).toBe(false);
  });
});

describe("the current language", () => {
  it("tells whoever is listening when it changes, and only then", () => {
    const heard: string[] = [];
    const stop = onLocaleChange((l) => heard.push(l));
    setLocale("de");
    setLocale("de");
    setLocale("fr");
    stop();
    setLocale("es");
    expect(heard).toEqual(["de", "fr"]);
    expect(getLocale()).toBe("es");
  });

  it("refuses what it doesn't speak", () => {
    setLocale("xx" as never);
    expect(getLocale()).toBe("tr");
    expect(isLocale("ar")).toBe(false);
    expect(isLocale("ko")).toBe(true);
  });

  it("finds the closest language to the system's", () => {
    expect(matchLocale(["de-AT", "en-US"])).toBe("de");
    expect(matchLocale(["zh-Hans-CN"])).toBe("zh");
    expect(matchLocale(["pt_BR"])).toBe("pt");
    expect(matchLocale(["ar-SA", "fr-CA"])).toBe("fr");
    expect(matchLocale(["ar-SA"])).toBeNull();
  });

  it("formats dates and lower-cases by the current language", () => {
    const at = new Date(2026, 8, 23, 14, 5);
    setLocale("de");
    expect(formatDate(at, { month: "long" })).toBe("September");
    setLocale("tr");
    expect(formatDate(at, { month: "long" })).toBe("Eylül");
    expect(lower("İSTANBUL")).toBe("istanbul");
    setLocale("en");
    expect(lower("TITLE")).toBe("title");
  });
});
it('attention task navigation labels keep the task title in all languages',()=>{
 const before=getLocale();try{for(const locale of LOCALES){setLocale(locale.code);expect(t('taskAttention.open',{title:'Synthetic VUN16'})).toContain('Synthetic VUN16');expect(t('taskAttention.title')).not.toBe('taskAttention.title');}}finally{setLocale(before);}
});
