import { describe, expect, it } from "vitest";
import { appleLanguages, followLanguage, type UserDefaults } from "../../src/main/system-language.js";

/** An app's own entry over the Mac's list, as NSUserDefaults reads them. */
function defaults(system: string[], own?: string[]): UserDefaults & { own: string[] | undefined; writes: number } {
  return {
    own,
    writes: 0,
    getUserDefault() { return this.own ?? system; },
    setUserDefault(_key, _type, value) { this.own = value; this.writes += 1; },
    removeUserDefault() { this.own = undefined; },
  };
}

describe("the language macOS runs the app in", () => {
  it("puts the chosen language before the Mac's own", () => {
    expect(appleLanguages("tr", ["en-GB"])).toEqual(["tr", "en-GB"]);
    expect(appleLanguages("de", ["en-US", "fr-FR"])).toEqual(["de", "en-US", "fr-FR"]);
  });

  it("uses macOS's name where the bare code is not one", () => {
    expect(appleLanguages("pt", ["en-GB"])).toEqual(["pt-BR", "en-GB"]);
    expect(appleLanguages("zh", ["en-GB"])).toEqual(["zh-Hans", "en-GB"]);
  });

  it("keeps the region of a Mac that already speaks the language", () => {
    expect(appleLanguages("en", ["tr-TR", "en-GB"])).toEqual(["en-GB", "tr-TR"]);
    expect(appleLanguages("pt", ["pt-PT", "en-GB"])).toEqual(["pt-PT", "en-GB"]);
  });

  it("writes the list for the app and hands back the Mac's own language", () => {
    const d = defaults(["en-GB"]);
    expect(followLanguage("tr", d)).toBe("en-GB");
    expect(d.own).toEqual(["tr", "en-GB"]);
  });

  it("reads the Mac's list, not what it wrote last time", () => {
    const d = defaults(["en-GB"], ["tr", "en-GB"]);
    expect(followLanguage("de", d)).toBe("en-GB");
    expect(d.own).toEqual(["de", "en-GB"]);
  });

  it("leaves a Mac already in the language without an entry", () => {
    const d = defaults(["tr-TR", "en-GB"], ["de", "tr-TR", "en-GB"]);
    expect(followLanguage("tr", d)).toBeNull();
    expect(d.own).toBeUndefined();
    expect(d.writes).toBe(0);
  });

  it("copes with a list it cannot read", () => {
    const d: UserDefaults & { own?: string[] } = {
      getUserDefault: () => undefined,
      setUserDefault(_key, _type, value) { this.own = value; },
      removeUserDefault() {},
    };
    expect(followLanguage("tr", d)).toBeNull();
    expect(d.own).toEqual(["tr"]);
  });

  it("names the Mac's language the way Chromium does", () => {
    expect(followLanguage("tr", defaults(["zh-Hant-TW", "en-GB"]))).toBe("zh-TW");
    expect(followLanguage("tr", defaults(["sr-Latn-RS"]))).toBe("sr-RS");
    expect(followLanguage("tr", defaults(["de"]))).toBe("de");
  });
});
