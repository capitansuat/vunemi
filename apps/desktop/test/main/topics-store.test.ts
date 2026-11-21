/**
 * Topic memory on disk: folders of Markdown that Vunemi writes and the user
 * may edit anywhere (Obsidian, say). The files are the record; the index
 * follows them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
