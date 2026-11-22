/**
 * Folders linked to a topic: their files are read where they are, kept in
 * the index while Vunemi is idle, and never copied (topics/linked.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathRefused } from "@vunemi/files";
import { TopicStore } from "../../src/main/topics/store.js";
import { defaultMeaning, LinkedSync, MEANING_SUBFOLDER_MAX, meaningOn } from "../../src/main/topics/linked.js";

let base: string;
let dir: string;
let store: TopicStore;
let sync: LinkedSync;
let convertCalls: number;
let failFor: string | null;
let refuse: boolean;
let errors: string[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-linked-"));
  dir = join(base, "ref");
  mkdirSync(dir);
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  store.createTopic("Library", "");
  store.setLinkedFolders("Library", [{ path: dir, meaning: {} }]);
  convertCalls = 0;
  failFor = null;
  refuse = false;
  errors = [];
  sync = new LinkedSync({
    store,
    roots: {
      resolve: (path: string) => {
        if (refuse) throw new PathRefused(`${path} is not open to Vunemi.`);
        return path;
      },
    },
    convert: async (from) => {
      convertCalls++;
      return from.map((path) => (failFor && path.endsWith(failFor) ? { error: "Not a web page." } : { markdown: `# Converted\n\n${path.split("/").pop()} body` }));
    },
    cacheDir: join(base, "cache"),
    inMeaning: () => false,
    log: (line) => errors.push(line),
  });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const later = (path: string) => {
  const t = new Date(Date.now() + 10_000);
  utimesSync(path, t, t);
};

describe("a linked folder", () => {
  it("indexes a linked folder's readable files, one file per document, and nothing hidden", async () => {
    for (const [name, text] of [["a.md", "# A\nalpha"], ["a.html", "<h1>A</h1>"], ["b.txt", "beta"], [".h.txt", "hidden"], ["x.py", "print()"]]) writeFileSync(join(dir, name!), text!);
    expect(await sync.run(() => true)).toBe("done");
    expect(store.linkedRows("Library").map((r) => r.rel).sort()).toEqual(["a.md", "b.txt"]);
    expect(store.search("alpha", "Library")).toMatchObject([{ kind: "file", title: "A", rel: "a.md" }]);
    expect(sync.counts("Library", dir)).toEqual({ files: 2, indexed: 2 });
    expect(sync.state("Library", dir)).toBe("ok");
  });

  it("leaves out hidden folders, links and app packages", async () => {
    mkdirSync(join(dir, ".cache"));
    writeFileSync(join(dir, ".cache", "c.txt"), "cache");
    mkdirSync(join(dir, "Pages.app"));
    writeFileSync(join(dir, "Pages.app", "inside.txt"), "package");
    writeFileSync(join(base, "elsewhere.txt"), "linked");
    symlinkSync(join(base, "elsewhere.txt"), join(dir, "link.txt"));
    writeFileSync(join(dir, "plan.md"), "# Plan");
    await sync.run(() => true);
    expect(store.linkedRows("Library").map((r) => r.rel)).toEqual(["plan.md"]);
  });

  it("converts a file once, by its hash, and again only when it changes", async () => {
    writeFileSync(join(dir, "c.html"), "<h1>old</h1>");
    await sync.run(() => true);
    await sync.run(() => true);
    expect(convertCalls).toBe(1);
    // Touched but the same: read again from the cache.
    later(join(dir, "c.html"));
    await sync.run(() => true);
    expect(convertCalls).toBe(1);
    writeFileSync(join(dir, "c.html"), "<h1>new</h1>");
    later(join(dir, "c.html"));
    await sync.run(() => true);
    expect(convertCalls).toBe(2);
  });

  it("reads subfolders, and names a file by its path inside the folder", async () => {
    mkdirSync(join(dir, "records", "2026"), { recursive: true });
    writeFileSync(join(dir, "records", "2026", "rows.csv"), "a,b");
    await sync.run(() => true);
    expect(store.linkedRows("Library").map((r) => r.rel)).toEqual(["records/2026/rows.csv"]);
  });

  it("drops a removed file, and a folder that is gone or no longer allowed", async () => {
    writeFileSync(join(dir, "b.txt"), "beta body");
    writeFileSync(join(dir, "c.txt"), "gamma body");
    await sync.run(() => true);
    rmSync(join(dir, "b.txt"));
    await sync.run(() => true);
    expect(store.linkedRows("Library").map((r) => r.rel)).toEqual(["c.txt"]);
    refuse = true;
    await sync.run(() => true);
    expect(sync.state("Library", dir)).toBe("refused");
    expect(store.search("body", "Library").filter((h) => h.kind === "file")).toEqual([]);
    refuse = false;
    rmSync(dir, { recursive: true });
    await sync.run(() => true);
    expect(sync.state("Library", dir)).toBe("missing");
  });

  it("forgets the files of a folder that was unlinked", async () => {
    writeFileSync(join(dir, "b.txt"), "beta");
    await sync.run(() => true);
    store.setLinkedFolders("Library", []);
    await sync.run(() => true);
    expect(store.linkedRows("Library")).toEqual([]);
  });

  it("skips a file it can't convert, says why, and tries it again next time", async () => {
    writeFileSync(join(dir, "bad.html"), "<x>");
    writeFileSync(join(dir, "good.txt"), "fine");
    failFor = "bad.html";
    expect(await sync.run(() => true)).toBe("done");
    expect(errors).toContainEqual(expect.stringContaining("bad.html"));
    expect(store.linkedRows("Library").map((r) => r.rel)).toEqual(["good.txt"]);
    failFor = null;
    await sync.run(() => true);
    expect(store.linkedRows("Library").map((r) => r.rel).sort()).toEqual(["bad.html", "good.txt"]);
  });

  it("cuts a file longer than a source may be", async () => {
    writeFileSync(join(dir, "big.txt"), "word ".repeat(420_000));
    await sync.run(() => true);
    expect(store.search("cut", "Library")).toMatchObject([{ kind: "file", rel: "big.txt" }]);
  });

  it("stops at the next batch when a task starts", async () => {
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `n${String(i).padStart(2, "0")}.txt`), `note ${i}`);
    let calls = 0;
    expect(await sync.run(() => ++calls < 2)).toBe("paused");
    expect(store.linkedRows("Library")).toHaveLength(20);
    expect(await sync.run(() => true)).toBe("done");
    expect(store.linkedRows("Library")).toHaveLength(50);
  });

  it("makes the topic's Index again after a pass that changed its files or pages", async () => {
    const index = join(base, "Memory", "Library", "Notes", "Index.md");
    writeFileSync(join(dir, "a.md"), "# A\n\n[b](b.md)");
    writeFileSync(join(dir, "b.md"), "# B");
    await sync.run(() => true);
    expect(readFileSync(index, "utf8")).toContain("ref: 2 files");
    store.writeNote("Library", { title: "Loan", text: "- QXA", by: "vunemi", sources: [] });
    await sync.run(() => true);
    expect(readFileSync(index, "utf8")).toContain('- "Loan"');
  });

  it("gives meaning to the top level and small subfolders, not to a large one, unless switched", async () => {
    for (const name of ["t1.txt", "t2.txt"]) writeFileSync(join(dir, name), "top words");
    mkdirSync(join(dir, "small"));
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, "small", `s${i}.txt`), "small words");
    mkdirSync(join(dir, "big"));
    for (let i = 0; i < MEANING_SUBFOLDER_MAX + 1; i++) writeFileSync(join(dir, "big", `b${i}.txt`), "big words");
    const byDefault = new LinkedSync({ store, roots: { resolve: (p: string) => p }, convert: null, cacheDir: join(base, "cache") });
    await byDefault.run(() => true);
    expect(store.pendingParts("m", "Library")).toBe(5);
    expect(byDefault.subfolders("Library", dir)).toEqual({ small: 3, big: MEANING_SUBFOLDER_MAX + 1 });
    // A switch the user set wins over the size, for files read after it.
    store.setLinkedFolders("Library", [{ path: dir, meaning: { small: false } }]);
    writeFileSync(join(dir, "small", "s9.txt"), "small words");
    await byDefault.run(() => true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(base, "data", "topics.db"));
    const parts = (path: string) => (db.prepare("SELECT COUNT(*) AS n FROM parts WHERE path = ?").get(path) as { n: number }).n;
    expect([parts(join(dir, "small", "s9.txt")), parts(join(dir, "small", "s0.txt")), parts(join(dir, "big", "b0.txt"))]).toEqual([0, 1, 0]);
    db.close();
  });

  it("decides by size where the user set no switch", () => {
    expect(defaultMeaning(MEANING_SUBFOLDER_MAX)).toBe(true);
    expect(defaultMeaning(MEANING_SUBFOLDER_MAX + 1)).toBe(false);
    expect(meaningOn({ path: dir, meaning: { big: true } }, "big", 5_000)).toBe(true);
    expect(meaningOn({ path: dir, meaning: {} }, "big", 5_000)).toBe(false);
  });

  it("makes parts only for files searched by meaning", async () => {
    writeFileSync(join(dir, "top.txt"), "top words");
    mkdirSync(join(dir, "big"));
    writeFileSync(join(dir, "big", "deep.txt"), "deep words");
    const meaning = new LinkedSync({ store, roots: { resolve: (p: string) => p }, convert: null, cacheDir: join(base, "cache"), inMeaning: (_t, _f, rel) => !rel.includes("/") });
    await meaning.run(() => true);
    expect(store.pendingParts("m", "Library")).toBe(1);
  });
});
