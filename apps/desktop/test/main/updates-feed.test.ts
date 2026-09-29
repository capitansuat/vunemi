import { describe, expect, it } from "vitest";
import { newer, PRODUCTION, readFeed } from "../../src/main/updates/feed.js";

const feed = (version: string, url = PRODUCTION.zip(version), extra: object = {}) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { version, name: `Vunemi ${version}`, url } }],
  sizeMb: 131,
  notes: { en: ["Updates."], tr: ["Güncellemeler."] },
  ...extra,
});

describe("newer", () => {
  it("compares numerically, and a test build comes before its release", () => {
    expect(newer("0.1.10", "0.1.9")).toBe(true);
    expect(newer("0.2.0", "0.1.99")).toBe(true);
    expect(newer("0.1.8", "0.1.8")).toBe(false);
    expect(newer("0.1.7", "0.1.8")).toBe(false);
    expect(newer("0.1.8-test2", "0.1.8-test1")).toBe(true);
    expect(newer("0.1.8", "0.1.8-test2")).toBe(true);
    expect(newer("banana", "0.1.8")).toBe(false);
  });
});

describe("readFeed", () => {
  it("offers a newer version with the notes in the user's language, English otherwise", () => {
    expect(readFeed(feed("0.1.9"), "0.1.8", "tr", PRODUCTION)).toEqual({ version: "0.1.9", notes: ["Güncellemeler."], sizeMb: 131 });
    expect(readFeed(feed("0.1.9"), "0.1.8", "ja", PRODUCTION)?.notes).toEqual(["Updates."]);
  });

  it("ignores the same or an older version", () => {
    expect(readFeed(feed("0.1.8"), "0.1.8", "en", PRODUCTION)).toBeNull();
    expect(readFeed(feed("0.1.7"), "0.1.8", "en", PRODUCTION)).toBeNull();
  });

  it("refuses a zip anywhere but the release's own address", () => {
    expect(readFeed(feed("0.1.9", "https://example.com/Vunemi-0.1.9-arm64.zip"), "0.1.8", "en", PRODUCTION)).toBeNull();
    expect(readFeed(feed("0.1.9", PRODUCTION.zip("0.1.10")), "0.1.8", "en", PRODUCTION)).toBeNull();
  });

  it("refuses a feed whose parts disagree or are missing", () => {
    expect(readFeed(null, "0.1.8", "en", PRODUCTION)).toBeNull();
    expect(readFeed({ currentRelease: "0.1.9" }, "0.1.8", "en", PRODUCTION)).toBeNull();
    expect(readFeed({ ...feed("0.1.9"), currentRelease: "0.2.0" }, "0.1.8", "en", PRODUCTION)).toBeNull();
  });

  it("keeps notes short and drops a size that is not a size", () => {
    const long = readFeed(feed("0.1.9", undefined, { notes: { en: ["x".repeat(500), 7, ...Array(30).fill("y")] }, sizeMb: "big" }), "0.1.8", "en", PRODUCTION)!;
    expect(long.notes[0]).toHaveLength(300);
    expect(long.notes).toHaveLength(20);
    expect(long.sizeMb).toBeNull();
  });
});
