/**
 * Checks of a topic's pages and folders, by code with no model: what the
 * Memory page lists under "Needs a look" (topics/checks.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicStore } from "../../src/main/topics/store.js";
import { checkTopic, MAX_CHECKS } from "../../src/main/topics/checks.js";

let base: string;
let store: TopicStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-checks-"));
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  store.createTopic("Library", "");
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const page = (title: string, text: string, more: { aliases?: string[]; cites?: { file: string; sha256: string }[] } = {}) =>
  store.writeNote("Library", { title, text, by: "vunemi", sources: [], ...more });

describe("checks", () => {
  it("finds dead links, lone pages, doubles, changed files and folders it can't read", () => {
    store.setLinkedFolders("Library", [{ path: "/gone/ref", meaning: {} }, { path: "/fine/ref", meaning: {} }]);
    store.putLinked("Library", { folder: "/fine/ref", rel: "t.md", path: "/fine/ref/t.md", title: "T", body: "t", size: 1, mtime: 1, sha256: "new", parts: false });
    page("A", "[[B]] [[Ghost]] [[t]]");
    page("B", "[[A]] [[D]]", { cites: [{ file: "ref/t.md", sha256: "old" }] });
    page("C", "lonely", { aliases: ["Same"] });
    page("D", "[[A]]", { aliases: ["same"] });
    store.writeGenerated("Library", "Index", "# Index\n\nmap");
    const checks = checkTopic(store, "Library", (folder) => (folder === "/gone/ref" ? "missing" : "ok"));
    expect(checks).toContainEqual({ kind: "deadLink", page: "A", link: "Ghost" });
    expect(checks).toContainEqual({ kind: "orphan", page: "C" });
    expect(checks).toContainEqual({ kind: "samePage", pages: ["C", "D"] });
    expect(checks).toContainEqual({ kind: "stale", page: "B", files: ["ref/t.md"] });
    expect(checks).toContainEqual({ kind: "folder", path: "/gone/ref", state: "missing" });
    expect(checks.map((c) => c.kind).sort()).toEqual(["deadLink", "folder", "orphan", "samePage", "stale"]);
  });

  it("calls no page lone when it is the only one", () => {
    page("A", "text");
    expect(checkTopic(store, "Library", () => "ok")).toEqual([]);
  });

  it("lists at most a few, the changed files first", () => {
    for (let i = 0; i < 60; i++) page(`P${i}`, "text", { cites: [{ file: "ref/gone.md", sha256: "x" }] });
    const checks = checkTopic(store, "Library", () => "ok");
    expect(checks).toHaveLength(MAX_CHECKS);
    expect(checks.every((c) => c.kind === "stale")).toBe(true);
  });
});
