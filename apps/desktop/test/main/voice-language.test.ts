import { describe, expect, it } from "vitest";
import { spokenIn, writtenIn } from "../../src/main/voice.js";

describe("the language a reply is read in", () => {
  it("knows it from the writing when the writing tells", () => {
    expect(writtenIn("Bugün hava güzel, dışarı çıkalım.")).toBe("tr");
    expect(writtenIn("Привет")).toBe("ru");
    expect(writtenIn("こんにちは")).toBe("ja");
    expect(writtenIn("你好")).toBe("zh");
    expect(writtenIn("안녕하세요")).toBe("ko");
    expect(writtenIn("¿Qué tal?")).toBe("es");
  });

  it("doesn't guess from letters several languages share", () => {
    expect(writtenIn("Dört")).toBeNull();
    expect(writtenIn("Four")).toBeNull();
  });
});

describe("the language that was spoken", () => {
  it("keeps whisper's guess when Vunemi speaks it", () => {
    expect(spokenIn({ tr: 0.82, en: 0.08 }, "tr")).toBe("tr");
  });

  it("falls back to the likeliest of Vunemi's languages when whisper hears another", () => {
    expect(spokenIn({ fa: 0.6, tr: 0.3, ar: 0.05, en: 0.02 }, "fa")).toBe("tr");
  });

  it("says nothing when none of Vunemi's languages is in the running", () => {
    expect(spokenIn({ fa: 0.9 }, "fa")).toBeNull();
    expect(spokenIn(undefined, undefined)).toBeNull();
  });
});
