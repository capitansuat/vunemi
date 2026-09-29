import { describe, expect, it } from "vitest";
import { supportUrl } from "../../src/main/support.js";

describe("supportUrl", () => {
  it("opens the support page in the app's language with the version after the #", () => {
    expect(supportUrl("tr", "0.1.8")).toBe("https://vunemi.com/tr/support/#version=0.1.8");
    expect(supportUrl("ja", "0.1.8-test2")).toBe("https://vunemi.com/ja/support/#version=0.1.8-test2");
  });

  it("falls back to English and leaves out a version that is not one", () => {
    expect(supportUrl("xx", "0.1.8")).toBe("https://vunemi.com/en/support/#version=0.1.8");
    expect(supportUrl("en", "0.1.8&x=<script>")).toBe("https://vunemi.com/en/support/");
  });
});
