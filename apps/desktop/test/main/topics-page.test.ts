/**
 * The Memory page's side in main: the tree, notes and sources as the window
 * shows them, and the user's own changes. Names come from the window and are
 * looked up, never taken as paths; nothing is written over a change made
 * meanwhile, and deletes go to the Trash.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale } from "@vunemi/i18n";
import { TopicStore } from "../../src/main/topics/store.js";
import { SHOWN_CHARS, topicPage, type TopicPageDeps } from "../../src/main/topics/page.js";
import { FOLDER_SCAN_LIMIT, pickedSources } from "../../src/main/topics/tools.js";

let base: string;
let store: TopicStore;
let trashed: string[];
let revealed: string[];
let left: string[];
let changes: number;
let picked: string[];
let page: ReturnType<typeof topicPage>;
let refuse: boolean;

const make = (over: Partial<TopicPageDeps> = {}) =>
  topicPage({
    store,
    find: null,
    convert: null,
    pickFiles: async () => picked,
    trash: async (path) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    reveal: (path) => revealed.push(path),
    leave: (topic) => left.push(topic),
    changed: () => changes++,
    roots: {
      resolve: (path: string) => {
        if (refuse) throw new Error(`${path} is not open to Vunemi.`);
        return path;
      },
    },
    linked: null,
    ...over,
  });

beforeEach(() => {
  setLocale("en");
  base = mkdtempSync(join(tmpdir(), "vunemi-topic-page-"));
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  trashed = [];
  revealed = [];
  left = [];
  changes = 0;
  picked = [];
  refuse = false;
  page = make();
  store.createTopic("Home renovation", "Bathroom and kitchen.");
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("what the page shows", () => {
  it("lists topics with their notes and sources by title", () => {
    store.writeNote("Home renovation", { title: "Budget", text: "180,000", by: "vunemi", sources: [] });
    store.addSource("Home renovation", { original: "/a/offer.pdf", markdown: "Tiles", bytes: 5, sha256: "a".repeat(64) });
    const tree = page.tree();
    expect(tree.root).toBe(join(base, "Memory"));
    expect(tree.canConvert).toBe(false);
    expect(tree.topics.map((tp) => [tp.name, tp.about, tp.notes.map((n) => n.title), tp.sources.map((s) => s.name)])).toEqual([["Home renovation", "Bathroom and kitchen.", ["Budget"], ["offer"]]]);
  });

  it("shows a note with its links, those that lead nowhere, and what links to it", () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total", by: "vunemi", sources: ["offer"] });
    store.writeNote("Home renovation", { title: "Tiles", text: "Within [[budget]], see [[Plumber]]", by: "vunemi", sources: [] });
    const tiles = page.note("home renovation", "tiles")!;
    expect(tiles).toMatchObject({ topic: "Home renovation", title: "Tiles", by: "vunemi", links: ["budget"], missing: ["Plumber"] });
    expect(page.note("Home renovation", "Budget")!.linkedFrom).toEqual(["Tiles"]);
    expect(page.note("Home renovation", "Nope")).toBeNull();
    expect(() => page.note("Elsewhere", "Budget")).toThrow(/isn’t in the memory folder any more/);
  });

  it("shows a source cut when very long, and whether its original is still there", () => {
    const original = join(base, "offer.pdf");
    writeFileSync(original, "x");
    store.addSource("Home renovation", { original, markdown: "y".repeat(SHOWN_CHARS + 5), bytes: 1, sha256: "b".repeat(64) });
    const source = page.source("Home renovation", "offer")!;
    expect(source).toMatchObject({ name: "offer", originalThere: true, cut: true });
    expect(source.chars).toBeGreaterThan(SHOWN_CHARS);
    expect(source.text).toHaveLength(SHOWN_CHARS);
    rmSync(original);
    expect(page.source("Home renovation", "offer")!.originalThere).toBe(false);
  });

  it("searches by words when meaning isn't there", async () => {
    store.writeNote("Home renovation", { title: "Plumber", text: "Kerem, Tuesdays", by: "vunemi", sources: [] });
    expect(await page.search("kerem", null)).toMatchObject({ byMeaning: false, hits: [{ kind: "note", title: "Plumber" }] });
    expect(await page.search("   ", null)).toEqual({ hits: [], pending: 0, byMeaning: false });
  });
});

describe("the user's own changes", () => {
  it("writes a new note as theirs", async () => {
    const note = await page.saveNote("Home renovation", { title: "Ideas", text: "Green tiles?" }, null);
    expect(note).toMatchObject({ title: "Ideas", by: "user", text: "Green tiles?" });
    expect(changes).toBe(1);
    await expect(page.saveNote("Home renovation", { title: "ideas", text: "x" }, null)).rejects.toThrow(/already a note called/);
    await expect(page.saveNote("Home renovation", { title: "a/b", text: "x" }, null)).rejects.toThrow(/can't be empty or contain/);
    await expect(page.saveNote("Home renovation", { title: "A", text: "  " }, null)).rejects.toThrow(/Write some text/);
  });

  it("edits a note, keeping where it came from, and refuses when it changed meanwhile", async () => {
    store.writeNote("Home renovation", { title: "Budget", text: "200,000", by: "vunemi", sources: ["offer"] });
    const opened = page.note("Home renovation", "Budget")!;
    const saved = await page.saveNote("Home renovation", { title: "Budget", text: "180,000" }, { title: opened.title, stamp: opened.stamp });
    expect(saved).toMatchObject({ text: "180,000", by: "user", sources: ["offer"] });
    // Vunemi (or Obsidian) wrote it after the user opened it.
    const path = join(base, "Memory", "Home renovation", "Notes", "Budget.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("180,000", "170,000"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    await expect(page.saveNote("Home renovation", { title: "Budget", text: "160,000" }, { title: "Budget", stamp: saved.stamp })).rejects.toThrow(/changed elsewhere/);
    expect(readFileSync(path, "utf8")).toContain("170,000");
  });

  it("renames a note: the old file goes to the Trash, a taken title is refused", async () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total", by: "vunemi", sources: [] });
    store.writeNote("Home renovation", { title: "Plumber", text: "Kerem", by: "vunemi", sources: [] });
    const opened = page.note("Home renovation", "Budget")!;
    await expect(page.saveNote("Home renovation", { title: "Plumber", text: "x" }, { title: "Budget", stamp: opened.stamp })).rejects.toThrow(/already a note called "?.?Plumber/);
    const renamed = await page.saveNote("Home renovation", { title: "Money", text: "Total" }, { title: "Budget", stamp: opened.stamp });
    expect(renamed.title).toBe("Money");
    expect(trashed).toEqual([join(base, "Memory", "Home renovation", "Notes", "Budget.md")]);
    expect(page.note("Home renovation", "Budget")).toBeNull();
  });

  it("deletes notes and sources to the Trash", async () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total", by: "vunemi", sources: [] });
    store.addSource("Home renovation", { original: "/a/offer.pdf", markdown: "Tiles", bytes: 5, sha256: "a".repeat(64) });
    await page.deleteNote("Home renovation", "budget");
    await page.deleteSource("Home renovation", "OFFER");
    expect(trashed.map((p) => p.split("/").slice(-2).join("/"))).toEqual(["Notes/Budget.md", "Sources/offer.md"]);
    // A name that isn't there deletes nothing, and no name reaches outside the topic.
    await page.deleteNote("Home renovation", "../../data/topics.db");
    expect(trashed).toHaveLength(2);
    expect(existsSync(join(base, "data", "topics.db"))).toBe(true);
  });

  it("makes a topic, refusing a name taken or one a folder can't have", () => {
    page.create("Taxes 2026", "Returns and receipts.");
    expect(store.findTopic("taxes 2026")?.about).toBe("Returns and receipts.");
    expect(() => page.create("TAXES 2026", "")).toThrow(/already a topic called/);
    expect(() => page.create("a:b", "")).toThrow(/can't be empty or contain/);
  });

  it("deletes a topic's folder to the Trash, and its conversations leave it", async () => {
    await page.deleteTopic("home renovation");
    expect(trashed).toEqual([join(base, "Memory", "Home renovation")]);
    expect(left).toEqual(["Home renovation"]);
    expect(store.findTopic("Home renovation")).toBeNull();
  });

  it("adds the files the user picked, and says which could not be", async () => {
    const files = join(base, "Picked");
    mkdirSync(files);
    writeFileSync(join(files, "notes.txt"), "Plain text");
    writeFileSync(join(files, "offer.pdf"), "%PDF");
    picked = [join(files, "notes.txt"), join(files, "offer.pdf")];
    expect(await page.addSources("Home renovation")).toEqual({ added: ["notes"], already: [], failed: [{ file: "offer.pdf", error: "This kind of file can't be added." }], skipped: 0, left: 0, copies: 0, stopped: false, linked: [] });
    expect(await page.addSources("Home renovation")).toMatchObject({ added: [], already: ["notes"] });
    picked = [];
    expect(await page.addSources("Home renovation")).toBeNull();
  });

  it("links a picked folder instead of copying it, and copies files picked one by one", async () => {
    const tree = join(base, "Renovation");
    mkdirSync(join(tree, "Offers", "2026"), { recursive: true });
    writeFileSync(join(tree, "plan.md"), "# Plan");
    writeFileSync(join(tree, "Offers", "tiles.txt"), "Tiles offer");
    writeFileSync(join(tree, "Offers", "2026", "plumber.txt"), "Plumber offer");
    writeFileSync(join(tree, "Offers", "photo.jpg"), "not text");
    mkdirSync(join(base, "Other"));
    writeFileSync(join(base, "Other", "notes.txt"), "Plain text");
    picked = [tree, join(base, "Other", "notes.txt")];
    const view = await page.addSources("Home renovation");
    expect(view).toMatchObject({ added: ["notes"], linked: [{ folder: tree, files: 3 }], failed: [] });
    expect(store.linkedFolders("Home renovation").map((f) => f.path)).toEqual([tree]);
    expect(readdirSync(join(base, "Memory", "Home renovation", "Sources"))).toEqual(["notes.md"]);
    // Again: the folder is already there.
    expect(await page.addSources("Home renovation")).toMatchObject({ linked: [], already: ["Renovation", "notes"] });
  });

  it("refuses a folder Vunemi may not read", async () => {
    const tree = join(base, "Renovation");
    mkdirSync(tree);
    refuse = true;
    picked = [tree];
    expect((await page.addSources("Home renovation"))!.failed).toEqual([{ file: "Renovation", error: "Vunemi isn't allowed to read this folder." }]);
    expect(store.linkedFolders("Home renovation")).toEqual([]);
  });

  it("unlinks a folder, and moves copies of linked files to the Trash only when asked", async () => {
    const tree = join(base, "Renovation");
    mkdirSync(tree);
    writeFileSync(join(tree, "plan.md"), "# Plan");
    store.setLinkedFolders("Home renovation", [{ path: tree, meaning: {} }]);
    store.putLinked("Home renovation", { folder: tree, rel: "plan.md", path: join(tree, "plan.md"), title: "Plan", body: "# Plan", size: 6, mtime: 1, sha256: "p", parts: false });
    store.addSource("Home renovation", { original: join(tree, "plan.html"), markdown: "Plan", bytes: 4, sha256: "q" });
    expect(page.tree().topics[0]!.copies).toBe(1);
    expect(page.tree().topics[0]!.folders).toEqual([{ path: tree, state: "ok", files: 0, indexed: 1 }]);
    expect(trashed).toEqual([]);
    expect(await page.removeCopies("Home renovation")).toBe(1);
    expect(page.tree().topics[0]!.copies).toBe(0);
    await page.unlink("Home renovation", tree);
    expect(store.linkedFolders("Home renovation")).toEqual([]);
    expect(existsSync(join(tree, "plan.md"))).toBe(true);
  });

  it("shows a linked file read only, and the original in Finder", () => {
    const tree = join(base, "Renovation");
    mkdirSync(tree);
    writeFileSync(join(tree, "plan.md"), "# Plan");
    store.setLinkedFolders("Home renovation", [{ path: tree, meaning: {} }]);
    store.putLinked("Home renovation", { folder: tree, rel: "plan.md", path: join(tree, "plan.md"), title: "Plan", body: "# Plan\n\nTiles first", size: 6, mtime: 1, sha256: "p", parts: false });
    expect(page.file("Home renovation", "Renovation/plan.md")).toMatchObject({ name: "Renovation/plan.md", folder: tree, rel: "plan.md", title: "Plan", text: "# Plan\n\nTiles first", cut: false, there: true });
    page.revealFile("Home renovation", "Renovation/plan.md");
    expect(revealed).toEqual([join(tree, "plan.md")]);
    expect(page.file("Home renovation", "Renovation/nothing.md")).toBeNull();
  });

  it("adds one file a document from a folder, the text one first, but every file the user picked one by one", async () => {
    const tree = join(base, "Reports");
    mkdirSync(join(tree, "Old"), { recursive: true });
    for (const name of ["term.html", "term.md", "Term.csv", "term.py", "fees.html", "fees.csv", "rows.csv"]) writeFileSync(join(tree, name), "x");
    writeFileSync(join(tree, "Old", "term.html"), "x");
    expect(await pickedSources([tree], true, 200)).toMatchObject({
      // fees: .html comes before .csv in what MarkItDown reads; Old is another folder.
      ok: [join(tree, "fees.html"), join(tree, "rows.csv"), join(tree, "term.md"), join(tree, "Old", "term.html")],
      copies: 3,
      skipped: 1,
    });
    expect(await pickedSources([join(tree, "term.html"), join(tree, "term.md")], true, 200)).toMatchObject({ ok: [join(tree, "term.html"), join(tree, "term.md")], copies: 0 });
  });

  it("adds no more files than the topic has room for, and stops looking through a huge folder", async () => {
    const tree = join(base, "Many");
    mkdirSync(tree);
    for (let i = 0; i < 5; i++) writeFileSync(join(tree, `n${i}.txt`), `note ${i}`);
    expect(await pickedSources([tree], false, 3)).toMatchObject({ ok: [0, 1, 2].map((i) => join(tree, `n${i}.txt`)), left: 2, stopped: false });
    const huge = join(base, "Huge");
    mkdirSync(huge);
    for (let i = 0; i <= FOLDER_SCAN_LIMIT; i++) writeFileSync(join(huge, `x${String(i).padStart(5, "0")}.bin`), "");
    expect(await pickedSources([huge], false, 200)).toMatchObject({ ok: [], skipped: FOLDER_SCAN_LIMIT, stopped: true });
  });

  it("shows in Finder only what the topic holds", () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total", by: "vunemi", sources: [] });
    page.reveal("Home renovation", null);
    page.reveal("Home renovation", { kind: "note", name: "Budget" });
    page.reveal("Home renovation", { kind: "note", name: "/etc/passwd" });
    expect(revealed).toEqual([join(base, "Memory", "Home renovation"), join(base, "Memory", "Home renovation", "Notes", "Budget.md")]);
  });
});
