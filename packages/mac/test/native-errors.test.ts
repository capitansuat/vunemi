import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@ocak/i18n";
import { nativeErrorText } from "../src/native-errors.js";

afterEach(() => setLocale("tr"));

describe("native helper errors", () => {
  it("keeps Turkish diagnostics in the Turkish interface", () => {
    setLocale("tr");
    expect(nativeErrorText("Erişilebilirlik izni yok.")).toBe("Erişilebilirlik izni yok.");
  });

  it("explains permissions and dynamic failures in English for other locales", () => {
    setLocale("de");
    expect(nativeErrorText("Erişilebilirlik izni yok.")).toBe("Accessibility permission is missing.");
    expect(nativeErrorText('"Notes" diye açık bir uygulama yok.')).toContain('"Notes"');
    expect(nativeErrorText("Başlangıç okunabilir bir tarih değil (ISO 8601 bekleniyor)."))
      .toBe("Start is not a valid ISO 8601 date.");
  });

  it("does not expose an unknown Turkish error outside Turkish UI", () => {
    setLocale("en");
    expect(nativeErrorText("Bilinmeyen yerel hata.")).toBe("The desktop helper reported an error.");
    expect(nativeErrorText("The system refused access.")).toBe("The system refused access.");
  });

  it("leaves English OS errors alone even when they start like a Turkish word", () => {
    setLocale("en");
    expect(nativeErrorText("Operation not permitted")).toBe("Operation not permitted");
    expect(nativeErrorText("Output device unavailable")).toBe("Output device unavailable");
    expect(nativeErrorText("Buffer too small")).toBe("Buffer too small");
    expect(nativeErrorText("O adda bir şey yok")).toBe("The desktop helper reported an error.");
  });
});
