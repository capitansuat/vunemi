/**
 * The Index: a short map of a topic, made by code, that Vunemi reads first
 * (topics/index-page.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicStore } from "../../src/main/topics/store.js";
import { INDEX_CHARS, INDEX_TITLE, indexPage, writeIndex } from "../../src/main/topics/index-page.js";
import { topicIndex } from "../../src/main/topics/index-text.js";
import { titleOf } from "../../src/main/topics/linked.js";

let base: string;
let store: TopicStore;
let indexPath: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-index-"));
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  store.createTopic("Library", "");
  indexPath = join(base, "Memory", "Library", "Notes", "Index.md");
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const put = (rel: string, body: string) =>
  store.putLinked("Library", { folder: "/x/library-reference", rel, path: `/x/library-reference/${rel}`, title: titleOf(body, rel), body, size: body.length, mtime: 1, sha256: rel, parts: false });

describe("the Index", () => {
  it("lists folders, the most linked files, codes and pages, in that order", () => {
    const text = indexPage({
      folders: [{ name: "library-reference", files: 12, subfolders: [{ name: "records", files: 10 }] }],
      hubs: [{ name: "library-reference/loan-period-reference.md", title: "Loan periods", inbound: 4 }],
      codes: [{ code: "QXA", files: 3, definedIn: "library-reference/loan-period-reference.md" }, { code: "BR", files: 2, definedIn: null }],
      pages: ["Loan"],
    });
    expect(text).toContain('- library-reference: 12 files, 2 at the top; records 10');
    expect(text).toContain('- library-reference/loan-period-reference.md "Loan periods", linked from 4');
    expect(text).toContain("- QXA: in 3 files, defined in library-reference/loan-period-reference.md");
    expect(text).toContain("- BR: in 2 files");
    expect(text).toContain('- "Loan"');
    const order = ["## Folders", "## Most linked files", "## Codes", "## Pages"].map((h) => text.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it("fits the map in its budget and says what was left out", () => {
    const text = indexPage({
      folders: [{ name: "library-reference", files: 9000, subfolders: Array.from({ length: 71 }, (_, i) => ({ name: `sub-${i}-${"x".repeat(30)}`, files: 100 - i })) }],
      hubs: Array.from({ length: 100 }, (_, i) => ({ name: `library-reference/hub-${i}-${"y".repeat(40)}.md`, title: `Hub ${i} ${"z".repeat(60)}`, inbound: 100 - i })),
      codes: Array.from({ length: 300 }, (_, i) => ({ code: `C${i}`, files: 300 - i, definedIn: `library-reference/defining-file-${i}.md` })),
      pages: Array.from({ length: 200 }, (_, i) => `Page ${i} ${"w".repeat(40)}`),
    });
    expect(text.length).toBeLessThanOrEqual(INDEX_CHARS);
    expect(text).toMatch(/more: topic_search/);
    for (const head of ["## Folders", "## Most linked files", "## Codes", "## Pages"]) expect(text).toContain(head);
  });

  it("is made from the topic's linked files and pages, and made again while it is Vunemi's", () => {
    store.setLinkedFolders("Library", [{ path: "/x/library-reference", meaning: {} }]);
    put("loan-period-reference.md", "# Loan periods\n\n| QXA | Standard loan |");
    put("calendar.md", "QXA starts; see [rules](loan-period-reference.html)");
    store.writeNote("Library", { title: "Loan", text: "- QXA", by: "vunemi", sources: [] });
    writeIndex(store, "Library");
    const first = readFileSync(indexPath, "utf8");
    expect(first).toContain("generated: true");
    expect(first).toContain('library-reference/loan-period-reference.md "Loan periods", linked from 1');
    expect(first).toContain("QXA: in 2 files, defined in library-reference/loan-period-reference.md");
    expect(first).toContain('- "Loan"');
    expect(first).not.toContain('- "Index"');
    put("fees.md", "[t](loan-period-reference.md)");
    writeIndex(store, "Library");
    expect(readFileSync(indexPath, "utf8")).toContain("linked from 2");
  });

  it("never writes over an Index the user made their own", () => {
    store.setLinkedFolders("Library", [{ path: "/x/library-reference", meaning: {} }]);
    mkdirSync(join(base, "Memory", "Library", "Notes"), { recursive: true });
    writeFileSync(indexPath, '---\ntitle: "Index"\n---\n\nmine');
    writeIndex(store, "Library");
    expect(readFileSync(indexPath, "utf8")).toContain("mine");
  });

  it("is not made for a topic with no linked folder", () => {
    store.writeNote("Library", { title: "Loan", text: "- QXA", by: "vunemi", sources: [] });
    writeIndex(store, "Library");
    expect(existsSync(indexPath)).toBe(false);
  });

  it("is named first in what a conversation is told of its topic", () => {
    store.setLinkedFolders("Library", [{ path: "/x/library-reference", meaning: {} }]);
    put("a.md", "# A");
    writeIndex(store, "Library");
    expect(topicIndex(store, "Library")).toContain(`Start with the page ${JSON.stringify(INDEX_TITLE)}`);
  });
});
