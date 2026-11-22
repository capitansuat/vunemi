/**
 * Topic memory on disk: folders of Markdown that Vunemi writes and the user
 * may edit anywhere (Obsidian, say). The files are the record; the index
 * follows them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanName, linksIn, parseNote, TOPIC_LIMITS, TopicStore } from "../../src/main/topics/store.js";

let base: string;
let root: string;
let store: TopicStore;
let clock: number;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-topics-"));
  root = join(base, "Documents", "Vunemi Memory");
  clock = Date.UTC(2026, 10, 21, 9, 0, 0);
  store = new TopicStore({ root: () => root, dataDir: join(base, "data"), now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

/** A change from outside Vunemi, as an editor saves it: new text, a later time. */
const editOutside = (path: string, text: string) => {
  writeFileSync(path, text);
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
};

describe("topics", () => {
  it("makes a folder with Notes, Sources and what it is about", () => {
    const topic = store.createTopic("Home renovation", "Bathroom and kitchen work, offers and the budget.");
    expect(topic.dir).toBe(join(root, "Home renovation"));
    expect(existsSync(join(topic.dir, "Notes"))).toBe(true);
    expect(existsSync(join(topic.dir, "Sources"))).toBe(true);
    expect(store.findTopic("home RENOVATION")?.about).toBe("Bathroom and kitchen work, offers and the budget.");
    expect(() => store.createTopic("home renovation", "")).toThrow(/already a topic/);
  });

  it("counts a folder the user made as a topic too", () => {
    mkdirSync(join(root, "Taxes 2026", "Notes"), { recursive: true });
    writeFileSync(join(root, "Taxes 2026", "Notes", "Deadlines.md"), "- 31 March");
    expect(store.listTopics().map((t) => [t.name, t.notes])).toEqual([["Taxes 2026", 1]]);
  });

  it.each(["", "a/b", "..", ".hidden", "x:y", "a [b]", "x".repeat(TOPIC_LIMITS.name + 1)])("refuses the name %j", (name) => {
    expect(() => cleanName(name, "topic")).toThrow();
  });

  it("keeps Turkish letters and case in a name", () => {
    expect(cleanName("  Ev   tadilatı İzmir ", "topic")).toBe("Ev tadilatı İzmir");
    store.createTopic("İzmir taşınma", "");
    expect(store.findTopic("izmir TAŞINMA")?.name).toBe("İzmir taşınma");
    expect(store.findTopic("IZMIR taşınma")?.name).toBe("İzmir taşınma");
  });
});

describe("notes", () => {
  beforeEach(() => store.createTopic("Home renovation", "Bathroom work."));

  it("writes Markdown with front matter, under its title", () => {
    const { note, replaced, previous } = store.writeNote("Home renovation", { title: "Tile choice", text: "- 60×60 matt porcelain\n- See [[Budget]]", by: "vunemi", sources: ["offer-2"] });
    expect(replaced).toBe(false);
    expect(previous).toBeNull();
    expect(note.path).toBe(join(root, "Home renovation", "Notes", "Tile choice.md"));
    const { meta, body } = parseNote(readFileSync(note.path, "utf8"));
    expect(meta).toMatchObject({ title: "Tile choice", by: "vunemi", sources: ["offer-2"], created: "2026-11-21T09:00:00.000Z" });
    expect(body.trim()).toBe("- 60×60 matt porcelain\n- See [[Budget]]");
    expect(note.links).toEqual(["Budget"]);
  });

  it("replaces a note of the same title, any case, keeping when it was made and what it was", () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Under 200,000", by: "vunemi", sources: [] });
    clock += 60_000;
    const { note, replaced, previous } = store.writeNote("Home renovation", { title: "budget", text: "Under 180,000", by: "vunemi", sources: [] });
    expect(replaced).toBe(true);
    expect(previous).toContain("Under 200,000");
    expect(note.title).toBe("budget");
    expect(note.created).toBe("2026-11-21T09:00:00.000Z");
    expect(note.updated).toBe("2026-11-21T09:01:00.000Z");
    expect(readdirSync(join(root, "Home renovation", "Notes"))).toEqual(["Budget.md"]);
    // The text it replaced is kept in Vunemi's own folder.
    const kept = readdirSync(join(base, "data", "topic-backups"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(base, "data", "topic-backups", kept[0]!), "utf8")).toContain("Under 200,000");
  });

  it("reads what the user changed in another editor, and searches by it", () => {
    const { note } = store.writeNote("Home renovation", { title: "Plumber", text: "Kerem, Tuesdays", by: "vunemi", sources: [] });
    editOutside(note.path, readFileSync(note.path, "utf8").replace("Kerem, Tuesdays", "Kerem moved to Thursdays"));
    expect(store.readNote("Home renovation", "plumber")?.text).toBe("Kerem moved to Thursdays");
    expect(store.search("thursdays").map((h) => h.title)).toEqual(["Plumber"]);
    expect(store.search("tuesdays")).toEqual([]);
  });

  it("takes a note without front matter as the user's, titled by its file", () => {
    writeFileSync(join(root, "Home renovation", "Notes", "My ideas.md"), "Green tiles? [[Tile choice|tiles]] and [[Budget#total]]");
    const note = store.readNote("Home renovation", "My ideas")!;
    expect(note.by).toBe("user");
    expect(note.links).toEqual(["Tile choice", "Budget"]);
  });

  it("lists the notes that link to one", () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total", by: "vunemi", sources: [] });
    store.writeNote("Home renovation", { title: "Tile choice", text: "Within [[budget]]", by: "vunemi", sources: [] });
    store.writeNote("Home renovation", { title: "Plumber", text: "Paid from [[Budget]]", by: "vunemi", sources: [] });
    expect(store.backlinks("Home renovation", "Budget").sort()).toEqual(["Plumber", "Tile choice"]);
  });

  it("refuses an empty note, a long one, and a title a file can't have", () => {
    expect(() => store.writeNote("Home renovation", { title: "A", text: "  ", by: "vunemi", sources: [] })).toThrow(/some text/);
    expect(() => store.writeNote("Home renovation", { title: "A", text: "x".repeat(TOPIC_LIMITS.text + 1), by: "vunemi", sources: [] })).toThrow(/at most/);
    expect(() => store.writeNote("Home renovation", { title: "a/b", text: "x", by: "vunemi", sources: [] })).toThrow(/can't contain/);
    expect(() => store.writeNote("No such topic", { title: "A", text: "x", by: "vunemi", sources: [] })).toThrow(/No topic/);
  });

  it("undo puts the old text back, or takes away a note that was new", () => {
    const first = store.writeNote("Home renovation", { title: "Budget", text: "Old", by: "vunemi", sources: [] });
    const second = store.writeNote("Home renovation", { title: "Budget", text: "New", by: "vunemi", sources: [] });
    store.restoreNote("Home renovation", "Budget", second.previous, () => {
      throw new Error("not expected");
    });
    expect(store.readNote("Home renovation", "Budget")?.text).toBe("Old");
    const trashed: string[] = [];
    store.restoreNote("Home renovation", "Budget", first.previous, (path) => trashed.push(path));
    expect(trashed).toEqual([join(root, "Home renovation", "Notes", "Budget.md")]);
  });

  it("writes nothing through a topic folder that leads elsewhere", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    store.createTopic("Linked", "");
    rmSync(join(root, "Linked", "Notes"), { recursive: true });
    symlinkSync(elsewhere, join(root, "Linked", "Notes"));
    expect(() => store.writeNote("Linked", { title: "A", text: "x", by: "vunemi", sources: [] })).toThrow(/outside the topics folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
    // A folder that is itself a link isn't taken for a topic at all.
    symlinkSync(elsewhere, join(root, "Elsewhere"));
    expect(store.findTopic("Elsewhere")).toBeNull();
  });
});

describe("sources", () => {
  beforeEach(() => store.createTopic("Home renovation", ""));
  const add = (original: string, markdown: string, sha256: string) => store.addSource("Home renovation", { original, markdown, bytes: 1234, sha256 });

  it("keeps a file's Markdown with where it came from", () => {
    const { source, added } = add("/Users/x/Downloads/offer-2.pdf", "| Item | Price |\n| --- | --- |\n| Tiles | 480 |", "a".repeat(64));
    expect(added).toBe(true);
    expect(source.name).toBe("offer-2");
    expect(source.original).toBe("/Users/x/Downloads/offer-2.pdf");
    expect(store.readSource("Home renovation", "Offer-2")?.text).toContain("| Tiles | 480 |");
    expect(store.search("tiles", "Home renovation")).toMatchObject([{ kind: "source", title: "offer-2" }]);
  });

  it("adds the same file once, and names two files of one name apart", () => {
    add("/a/rapor.pdf", "pdf text", "1".repeat(64));
    expect(add("/b/rapor.pdf", "pdf text", "1".repeat(64)).added).toBe(false);
    expect(add("/a/rapor.docx", "docx text", "2".repeat(64)).source.name).toBe("rapor.docx");
    expect(add("/c/rapor.docx", "other text", "3".repeat(64)).source.name).toBe("rapor 2");
  });

  it("cuts a very long file's text and says so", () => {
    const { source } = add("/a/big.pdf", "x".repeat(TOPIC_LIMITS.sourceChars + 10), "4".repeat(64));
    expect(store.readSource("Home renovation", source.name)!.text).toMatch(/\[Cut here: the file's text was longer than/);
  });
});

describe("helpers", () => {
  it("reads front matter Obsidian or Vunemi wrote, and none", () => {
    expect(parseNote("---\ntitle: \"A\"\ntags: [x, y]\nplain: hello\n---\nBody")).toEqual({ meta: { title: "A", tags: "[x, y]", plain: "hello" }, body: "Body" });
    expect(parseNote("No front matter")).toEqual({ meta: {}, body: "No front matter" });
  });

  it("finds links once each", () => {
    expect(linksIn("[[A]] [[a]] [[B|b]] [[C#x]] [[D^y]] [not] [[]]")).toEqual(["a", "B", "C", "D"]);
  });
});

describe("the index while another program reads it", () => {
  it("waits for the reader instead of failing at once", async () => {
    store.createTopic("Home renovation", "");
    store.writeNote("Home renovation", { title: "Tiles", text: "Matte, 60×60", by: "user", sources: [] });
    // Another process holds a read lock for a moment, as a backup or viewer would.
    const reader = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN"); db.prepare("SELECT COUNT(*) FROM files").get();
      process.stdout.write("held\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);
    `, join(base, "data", "topics.db")], { stdio: ["ignore", "pipe", "inherit"] });
    await once(reader.stdout!, "data");
    // Bringing the index up to date writes to it while the reader still holds it.
    expect(() => store.refresh()).not.toThrow();
    await once(reader, "exit");
    expect(store.search("matte", "Home renovation", 5).map((h) => h.title)).toEqual(["Tiles"]);
  });
});

describe("linked folders in the index", () => {
  const MODEL = "test-model";
  /** The index as version 2 made it: notes and sources only. */
  const V2 = `
CREATE TABLE files (path TEXT PRIMARY KEY, topic_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('note', 'source')), title TEXT NOT NULL, title_key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL);
CREATE INDEX files_topic ON files(topic_key, kind);
CREATE VIRTUAL TABLE files_fts USING fts5(title, body, content='files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN INSERT INTO files_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
CREATE TABLE parts (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, start INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB, vector_model TEXT);
PRAGMA user_version = 2;`;

  it("moves an index of version 2 to version 3 and keeps every vector", async () => {
    store.close();
    const dir = join(root, "Library", "Sources");
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "a.md");
    writeFileSync(source, '---\noriginal: "/Users/x/a.html"\n---\n\nAlpha library');
    const st = (await import("node:fs")).statSync(source);
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(join(base, "old"));
    const db = new DatabaseSync(join(base, "old", "topics.db"));
    db.exec(V2);
    db.prepare("INSERT INTO files VALUES (?, 'library', 'source', 'a', 'a', 'Alpha library', ?, ?)").run(source, st.size, st.mtimeMs);
    db.prepare("INSERT INTO parts (path, start, text, vector, vector_model) VALUES (?, 0, 'Alpha library', ?, ?)").run(source, new Uint8Array(new Float32Array([1, 0]).buffer), MODEL);
    db.close();
    store = new TopicStore({ root: () => root, dataDir: join(base, "old"), now: () => clock });
    store.refresh();
    const check = new DatabaseSync(join(base, "old", "topics.db"));
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(check.prepare("SELECT original FROM files WHERE path = ?").get(source)).toEqual({ original: "/Users/x/a.html" });
    check.close();
    expect(store.pendingParts(MODEL)).toBe(0);
    expect(store.search("alpha", "Library").map((h) => h.kind)).toEqual(["source"]);
  });

  it("keeps a topic's linked folders in topic.md, and its description beside them", () => {
    store.createTopic("Library", "Branches");
    store.setLinkedFolders("Library", [{ path: "/tmp/ref", meaning: { records: false } }]);
    store.setAbout("Library", "Branches and loans");
    expect(store.linkedFolders("Library")).toEqual([{ path: "/tmp/ref", meaning: { records: false } }]);
    expect(store.findTopic("Library")!.about).toBe("Branches and loans");
  });

  it("indexes a linked file for words, with parts only when asked", () => {
    store.createTopic("Library", "");
    const folder = join(base, "ref");
    mkdirSync(folder);
    const row = { folder, rel: "loan-period-reference.html", path: join(folder, "loan-period-reference.html"), title: "Loan period reference", body: "QXA Standard loan", size: 10, mtime: 1, sha256: "s1", parts: false };
    // A hit is shown only while its file is there, as for notes and sources.
    writeFileSync(row.path, "x");
    store.putLinked("Library", row);
    expect(store.search("standard", "Library")).toMatchObject([{ kind: "file", rel: "loan-period-reference.html", folder, title: "Loan period reference" }]);
    expect(store.pendingParts(MODEL, "Library")).toBe(0);
    store.putLinked("Library", { ...row, parts: true });
    expect(store.pendingParts(MODEL, "Library")).toBe(1);
    expect(store.linkedRows("Library")).toEqual([{ path: row.path, rel: row.rel, folder, size: 10, mtime: 1, sha256: "s1" }]);
    store.dropLinked("Library", [row.path]);
    expect(store.search("standard", "Library")).toEqual([]);
    expect(store.pendingParts(MODEL, "Library")).toBe(0);
  });

  it("leaves linked files alone when it brings notes and sources up to date", () => {
    store.createTopic("Library", "");
    const path = join(base, "ref", "x.txt");
    mkdirSync(join(base, "ref"));
    writeFileSync(path, "x");
    store.putLinked("Library", { folder: join(base, "ref"), rel: "x.txt", path, title: "x", body: "zebra", size: 1, mtime: 1, sha256: "h", parts: false });
    store.refresh();
    expect(store.search("zebra", "Library").map((h) => h.kind)).toEqual(["file"]);
  });
});

describe("the skeleton of linked files", () => {
  const put = (rel: string, body: string) =>
    store.putLinked("Library", { folder: "/ref", rel, path: `/ref/${rel}`, title: rel, body, size: body.length, mtime: 1, sha256: rel, parts: false });

  it("knows what links where, both ways, also to a file indexed after the link", () => {
    store.createTopic("Library", "");
    put("calendar.md", "# Calendar\n\nSee [loans](loans/rule.html) and [[library]] and [web](https://x.org).");
    put("loans/rule.md", "# Rules\n\n[back](../calendar.md)");
    expect(store.linksFrom("/ref/calendar.md")).toEqual(["/ref/loans/rule.md"]);
    put("library.md", "# Library");
    expect(store.linksFrom("/ref/calendar.md")).toEqual(["/ref/loans/rule.md", "/ref/library.md"]);
    expect(store.linksTo("/ref/calendar.md")).toEqual(["/ref/loans/rule.md"]);
    expect(store.linksTo("/ref/library.md")).toEqual(["/ref/calendar.md"]);
  });

  it("finds the files that use a code, the one defining it first", () => {
    store.createTopic("Library", "");
    put("mentions.md", "QXA QXA QXA in the calendar");
    put("loans.md", "# Loans\n\n| QXA | Standard loan |");
    expect(store.codeFiles("Library", "QXA").map((f) => [f.path, f.defined])).toEqual([
      ["/ref/loans.md", true],
      ["/ref/mentions.md", false],
    ]);
  });

  it("puts a document defining a code before a data file that repeats it", () => {
    store.createTopic("Library", "");
    put("mappings.csv", Array.from({ length: 50 }, () => "| BR | QXA | x |").join("\n"));
    put("loan-period-reference.md", "# Loans\n\n| BR | QXA | Central |");
    expect(store.codeFiles("Library", "QXA").map((f) => f.path)).toEqual(["/ref/loan-period-reference.md", "/ref/mappings.csv"]);
    expect(store.topCodes("Library", 5).find((c) => c.code === "QXA")?.definedIn).toBe("ref/loan-period-reference.md");
  });

  it("forgets a file's links and codes when it leaves the index", () => {
    store.createTopic("Library", "");
    put("a.md", "# QXA\n\n[b](b.md)");
    put("b.md", "# B");
    store.dropLinked("Library", ["/ref/a.md"]);
    expect(store.linksTo("/ref/b.md")).toEqual([]);
    expect(store.codeFiles("Library", "QXA")).toEqual([]);
  });
});

describe("pages over linked files", () => {
  const put = (rel: string) =>
    store.putLinked("Library", { folder: "/x/ref", rel, path: `/x/ref/${rel}`, title: rel, body: "text", size: 4, mtime: 1, sha256: rel, parts: false });

  it("resolves [[stem]] to a page, then to a linked file, and asks for the folder when two match", () => {
    store.createTopic("Library", "");
    store.writeNote("Library", { title: "Loan", text: "- QXA", by: "vunemi", sources: [], aliases: ["QXA"] });
    put("loan-period-reference.md");
    put("a/readme.md");
    put("b/readme.md");
    expect(store.resolveWiki("Library", "Loan")).toEqual({ kind: "note", title: "Loan" });
    expect(store.resolveWiki("Library", "qxa")).toEqual({ kind: "note", title: "Loan" });
    expect(store.resolveWiki("Library", "loan-period-reference")).toEqual({ kind: "file", name: "ref/loan-period-reference.md" });
    expect(store.resolveWiki("Library", "ref/a/readme")).toEqual({ kind: "file", name: "ref/a/readme.md" });
    expect(store.resolveWiki("Library", "readme")).toEqual({ kind: "ambiguous", names: ["ref/a/readme.md", "ref/b/readme.md"] });
    expect(store.resolveWiki("Library", "nowhere")).toBeNull();
  });

  it("reads a page whose front matter the user removed", () => {
    store.createTopic("Library", "");
    mkdirSync(join(root, "Library", "Notes"), { recursive: true });
    writeFileSync(join(root, "Library", "Notes", "Plain.md"), "Just text");
    expect(store.readNote("Library", "Plain")).toMatchObject({ aliases: [], cites: [] });
  });

  it("finds the page another page already is, by title or another name", () => {
    store.createTopic("Library", "");
    store.writeNote("Library", { title: "Loan", text: "- QXA", by: "vunemi", sources: [], aliases: ["QXA"] });
    expect(store.samePage("Library", "qxa", [])).toBe("Loan");
    expect(store.samePage("Library", "Rule", ["loan"])).toBe("Loan");
    expect(store.samePage("Library", "Loan", ["QXA"])).toBeNull();
    expect(store.samePage("Library", "Fees", [])).toBeNull();
  });
});
