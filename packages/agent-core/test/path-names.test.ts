import { expect, it } from "vitest";
import { baseNameOf, tildeMatches } from "../src/path-names.js";

it("names the last part of a path written with either separator", () => {
  expect(baseNameOf("C:\\a\\b\\rapor.xlsx")).toBe("rapor.xlsx");
  expect(baseNameOf("/a/b/rapor.xlsx")).toBe("rapor.xlsx");
  expect(baseNameOf("rapor.xlsx")).toBe("rapor.xlsx");
});

it("matches a ~ path with the full path it names, on any system", () => {
  expect(tildeMatches("~/x/rates.xlsx", "C:\\Users\\d\\x\\rates.xlsx")).toBe(true);
  expect(tildeMatches("~\\x\\rates.xlsx", "/home/d/x/rates.xlsx")).toBe(true);
  expect(tildeMatches("~/x/rates.xlsx", "/Users/d/x/rates.xlsx")).toBe(true);
  expect(tildeMatches("~/x/rates.xlsx", "C:\\Users\\d\\y\\rates.xlsx")).toBe(false);
  expect(tildeMatches("x/rates.xlsx", "/Users/d/x/rates.xlsx")).toBe(false);
});
