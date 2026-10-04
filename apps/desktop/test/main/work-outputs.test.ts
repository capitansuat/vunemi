import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchivedOutputs } from "../../src/main/work/outputs.js";
import { WorkStore } from "../../src/main/work/store.js";

let dir = "";
let store: WorkStore;
let conversation = "c1";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-work-out-"));
  store = new WorkStore(dir);
  conversation = "c1";
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("kept output on disk", () => {
  const page = Array.from({ length: 40 }, (_, i) => `line ${i} of the page`).join("\n");

  it("shows the first part, and reads the rest after a restart", () => {
    const kept = new ArchivedOutputs(store, () => conversation);
    const shown = kept.keep("page_read", page, 100);
    expect(shown.startsWith(page.slice(0, 100))).toBe(true);
    expect(shown).toContain('kept as "o1"');
    store.close();
    store = new WorkStore(dir);
    const again = new ArchivedOutputs(store, () => conversation);
    expect(again.read("o1", 2)).toContain("[Part 2 of");
    expect(again.search("o1", "line 37")).toMatch(/^\(part \d+\) line 37 of the page$/);
    expect(again.toolOf("o1")).toBe("page_read");
  });

  it("reads only the current conversation's outputs", () => {
    const kept = new ArchivedOutputs(store, () => conversation);
    kept.keep("page_read", page, 100);
    conversation = "c2";
    expect(() => kept.read("o1", 2)).toThrow(/no longer kept/);
    expect(kept.toolOf("o1")).toBeUndefined();
  });
});
