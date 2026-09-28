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
  it("is the app's language when whisper is unsure, as it is on one word", () => {
    expect(spokenIn({ ar: 0.45, en: 0.2, tr: 0.15, fa: 0.1 }, "tr")).toBe("tr");
    expect(spokenIn({ en: 0.4, tr: 0.35 }, "tr")).toBe("tr");
  });

  it("is another of Vunemi's languages when whisper is sure of it", () => {
    expect(spokenIn({ en: 0.93, tr: 0.02 }, "tr")).toBe("en");
    expect(spokenIn({ tr: 0.82, az: 0.1, en: 0.03 }, "en")).toBe("tr");
  });

  it("never picks a language Vunemi doesn't speak", () => {
    expect(spokenIn({ fa: 0.9, tr: 0.05 }, "en")).toBe("en");
    expect(spokenIn(undefined, "de")).toBe("de");
  });
});
