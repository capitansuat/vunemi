/**
 * The model's topic tools: notes kept about a subject the user chose, from
 * files the user gives and from the conversation. Writing is Vunemi's own
 * folder (no card) and can be undone; making a topic or joining one asks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Roots } from "@vunemi/files";
import { setLocale } from "@vunemi/i18n";
import type { ToolContext, ToolDef } from "@vunemi/agent-core";
import { parseNote, TopicStore } from "../../src/main/topics/store.js";
import { topicTools, type TopicToolsOptions } from "../../src/main/topics/tools.js";

let base: string;
let files: string;
let store: TopicStore;
let topic: string | null;
let outside: string[];
let trashed: string[];
let converted: string[][];
let undos: { label: string; fn: () => Promise<void> }[];
let tools: Map<string, ToolDef>;

const ctx = () =>
  ({
    signal: new AbortController().signal,
    runId: "r1",
    offerUndo: (label: string, fn: () => Promise<void>) => undos.push({ label, fn }),
  }) as unknown as ToolContext;
const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, ctx());
const check = (name: string, args: Record<string, unknown>) => tools.get(name)!.check!(args);

function make(over: Partial<TopicToolsOptions> = {}): Map<string, ToolDef> {
  return new Map(
    topicTools({
      store,
      where: () => ({ conversationId: "s_abc123", conversationTitle: "Bathroom offers", topic }),
      link: (name) => {
        topic = name;
      },
      sources: () => outside,
      redact: (text) => text.replace("hunter2", "[hidden secret]"),
      roots: new Roots([files]),
      convert: async (from) => {
        converted.push(from);
        return from.map((p) => (p.endsWith("broken.pdf") ? { error: "No text found." } : { markdown: `# ${p.split("/").pop()}\n\n| Item | Price |\n| --- | --- |\n| Tiles | 480 |` }));
      },
      trash: async (path) => {
        trashed.push(path);
        rmSync(path);
      },
      now: () => Date.UTC(2026, 10, 21),
      ...over,
    }).map((t) => [t.name, t]),
  );
}

beforeEach(() => {
  setLocale("en");
  base = mkdtempSync(join(tmpdir(), "vunemi-topic-tools-"));
  files = join(base, "Downloads");
  mkdirSync(files, { recursive: true });
  store = new TopicStore({ root: () => join(base, "Documents", "Vunemi Memory"), dataDir: join(base, "data") });
  topic = null;
  outside = [];
  trashed = [];
  converted = [];
  undos = [];
  tools = make();
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("without a topic", () => {
  it("lists none, and asks which topic before writing", async () => {
    expect(await run("topic_list", {})).toMatch(/no topics yet/);
    expect(check("topic_note_write", { title: "A", text: "b" })).toMatch(/isn't in a topic/);
    await expect(run("topic_note_write", { title: "A", text: "b" })).rejects.toThrow(/isn't in a topic/);
  });

  it("makes a topic with a card and puts the conversation in it", async () => {
    const create = tools.get("topic_create")!;
    expect(create.actionClass).toBe("write-local");
    expect(await create.preview!({ name: "Home renovation" })).toBe("Make the topic “Home renovation” and put this conversation in it");
    expect(await run("topic_create", { name: "Home renovation", about: "Bathroom and kitchen." })).toMatch(/put this conversation in it/);
    expect(topic).toBe("Home renovation");
    expect(check("topic_create", { name: "home renovation", about: "" })).toMatch(/already a topic/);
  });

  it("joins an existing topic, any case, and is shown its notes", async () => {
    store.createTopic("Taxes 2026", "");
    store.writeNote("Taxes 2026", { title: "Deadlines", text: "31 March", by: "vunemi", sources: [] });
    expect(tools.get("topic_use")!.actionClass).toBe("write-local");
    expect(check("topic_use", { name: "Nope" })).toMatch(/No topic/);
    const said = await run("topic_use", { name: "taxes 2026" });
    expect(topic).toBe("Taxes 2026");
    expect(said).toContain('"Deadlines"');
  });
});

describe("in a topic", () => {
  beforeEach(() => {
    store.createTopic("Home renovation", "Bathroom work.");
    topic = "Home renovation";
  });

  it("writes a note without a card, saying where it came from, and undo takes it away", async () => {
    const write = tools.get("topic_note_write")!;
    expect(write.actionClass).toBe("read");
    expect(write.saves).toBe(true);
    outside = ["example.com"];
    expect(await run("topic_note_write", { title: "Budget", text: "- Under 180,000\n- Wi-Fi password hunter2" })).toBe('Saved the note "Budget" in "Home renovation".');
    const note = store.readNote("Home renovation", "Budget")!;
    expect(note.text).toContain("[hidden secret]");
    expect(note.text).not.toContain("hunter2");
    expect(note.sources).toEqual(["conversation: Bathroom offers, 2026-11-21", "outside content: example.com"]);
    expect(undos.map((u) => u.label)).toEqual(["Remove the note “Budget”"]);
    await undos[0]!.fn();
    expect(store.readNote("Home renovation", "Budget")).toBeNull();
    expect(trashed).toHaveLength(1);
  });

  it("replacing a note can be undone to the old text", async () => {
    await run("topic_note_write", { title: "Budget", text: "Old" });
    await run("topic_note_write", { title: "budget", text: "New" });
    expect(undos.at(-1)!.label).toBe("Put the note “budget” back as it was");
    await undos.at(-1)!.fn();
    expect(store.readNote("Home renovation", "Budget")!.text).toBe("Old");
  });

  it("names only sources the topic has", async () => {
    await expect(run("topic_note_write", { title: "A", text: "b", sources: ["ghost"] })).rejects.toThrow(/no source called "ghost"/);
  });

  it("adds files as sources in one conversion, reads them, and notes them", async () => {
    writeFileSync(join(files, "offer-2.pdf"), "%PDF fake");
    writeFileSync(join(files, "broken.pdf"), "%PDF broken");
    writeFileSync(join(files, "notes.txt"), "Plain text from the user");
    const said = await run("topic_add_sources", { paths: [join(files, "offer-2.pdf"), join(files, "broken.pdf"), join(files, "notes.txt")] });
    expect(converted.map((call) => call.map((p) => p.split("/").pop()))).toEqual([["offer-2.pdf", "broken.pdf"]]);
    expect(said).toMatch(/offer-2\.pdf: added as the source "offer-2"/);
    expect(said).toMatch(/broken\.pdf: not added\. No text found\./);
    expect(said).toMatch(/notes\.txt: added as the source "notes"/);
    expect(undos.map((u) => u.label)).toEqual(["Remove the 2 added sources"]);
    // The originals are untouched.
    expect(readFileSync(join(files, "offer-2.pdf"), "utf8")).toBe("%PDF fake");

    const read = await run("topic_source_read", { name: "offer-2" });
    expect(read).toContain("| Tiles | 480 |");
    expect(tools.get("topic_source_read")!.untrustedOutput).toBe(true);

    expect(await run("topic_note_write", { title: "Tile choice", text: "480 per m²", sources: ["OFFER-2"] })).toMatch(/Saved/);
    expect(store.readNote("Home renovation", "Tile choice")!.sources[0]).toBe("offer-2");

    // The same file again is the same source.
    expect(await run("topic_add_sources", { paths: [join(files, "offer-2.pdf")] })).toMatch(/already in "Home renovation" as "offer-2"/);
  });

  it("reads files only from the folders opened to Vunemi", () => {
    const elsewhere = join(base, "Private");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "secret.txt"), "x");
    expect(check("topic_add_sources", { paths: [join(elsewhere, "secret.txt")] })).toBeTruthy();
  });

  it("says when this build can't convert, for anything but text", () => {
    tools = make({ convert: null });
    writeFileSync(join(files, "a.pdf"), "x");
    writeFileSync(join(files, "b.md"), "x");
    expect(check("topic_add_sources", { paths: [join(files, "a.pdf")] })).toMatch(/can't convert/);
    expect(check("topic_add_sources", { paths: [join(files, "b.md")] })).toBeNull();
  });

  it("reads a note with what links to it, and searches here or everywhere", async () => {
    await run("topic_note_write", { title: "Budget", text: "Total 180,000" });
    await run("topic_note_write", { title: "Plumber", text: "Kerem, paid from [[Budget]]" });
    store.createTopic("Taxes 2026", "");
    store.writeNote("Taxes 2026", { title: "Kerem invoice", text: "Kerem's invoice for the bathroom", by: "vunemi", sources: [] });
    const read = await run("topic_note_read", { title: "budget" });
    expect(read).toMatch(/^Budget \(Home renovation; written by Vunemi, \d{4}-\d{2}-\d{2}\)/);
    expect(read).toContain("Linked from: Plumber");
    expect(await run("topic_search", { query: "kerem" })).toMatch(/note "Plumber"/);
    expect(await run("topic_search", { query: "kerem" })).not.toMatch(/invoice/);
    expect(await run("topic_search", { query: "kerem", everywhere: true })).toMatch(/note "Kerem invoice" in Taxes 2026/);
    for (const name of ["topic_note_read", "topic_search", "topic_list"]) expect(tools.get(name)!.untrustedOutput, name).toBe(true);
  });

  it("searches by meaning when it can, pointing into a source, and says what waits", async () => {
    tools = make({
      find: async (query, where, limit) => ({
        hits: [{ kind: "source", topic: "Home renovation", title: "offer-2", snippet: `Seramik 60×60,\n\nmat. ${"x".repeat(600)}`, path: "/p", at: 12_400 }],
        pending: query === "tiles" && where === "Home renovation" && limit === 10 ? 7 : 0,
        byMeaning: true,
      }),
    });
    const said = await run("topic_search", { query: "tiles" });
    expect(said).toMatch(/^- source "offer-2" \(read from offset 12400\): Seramik 60×60, mat\. x+…$/m);
    expect(said.split("\n")[0]!.length).toBeLessThan(470);
    expect(said).toContain("[7 parts aren't searchable by meaning yet; they were searched by words.]");
  });

  it("stops when the topic's folder is gone", async () => {
    rmSync(join(base, "Documents", "Vunemi Memory", "Home renovation"), { recursive: true });
    await expect(run("topic_note_write", { title: "A", text: "b" })).rejects.toThrow(/no longer in the topics folder/);
    expect(existsSync(join(base, "Documents", "Vunemi Memory", "Home renovation"))).toBe(false);
  });
});

describe("files a note is made of", () => {
  it("is Markdown with front matter any editor opens", async () => {
    store.createTopic("Home renovation", "");
    topic = "Home renovation";
    await run("topic_note_write", { title: "Budget", text: "- Total" });
    const file = readFileSync(join(base, "Documents", "Vunemi Memory", "Home renovation", "Notes", "Budget.md"), "utf8");
    expect(file.startsWith("---\ntitle: \"Budget\"\n")).toBe(true);
    expect(parseNote(file).body.trim()).toBe("- Total");
  });
});

describe("linked folders", () => {
  let ref: string;
  const link = (rel: string, body: string, title = rel) => {
    const path = join(ref, rel);
    writeFileSync(path, body);
    store.putLinked("Library", { folder: ref, rel, path, title, body, size: body.length, mtime: 1, sha256: rel, parts: false });
  };

  beforeEach(() => {
    store.createTopic("Library", "Branches and loans");
    topic = "Library";
    ref = join(base, "library-reference");
    mkdirSync(ref);
    store.setLinkedFolders("Library", [{ path: ref, meaning: {} }]);
  });

  it("finds linked files and reads them by folder and path, fenced as untrusted", async () => {
    link("loan-period-reference.md", "# Loan periods\n\n| QXA | Standard loan |", "Loan periods");
    const out = String(await run("topic_search", { query: "standard loan" }));
    expect(out).toContain('- file "library-reference/loan-period-reference.md"');
    const read = String(await run("topic_source_read", { name: "library-reference/loan-period-reference.md" }));
    expect(read).toContain("QXA");
    expect(read.split("\n")[0]).toContain("library-reference/loan-period-reference.md");
    expect(tools.get("topic_source_read")!.untrustedOutput).toBe(true);
    expect(String(await run("topic_list", {}))).toContain("1 linked file");
  });

  it("shows the linked file, not its copy, when both are in the topic", () => {
    link("a.md", "alpha library");
    const sources = join(base, "Documents", "Vunemi Memory", "Library", "Sources");
    store.addSource("Library", { original: join(ref, "a.html"), markdown: "alpha library", bytes: 1, sha256: "x" });
    expect(store.copiesInLinked("Library")).toEqual([join(sources, "a.md")]);
    expect(store.search("alpha", "Library").map((h) => h.kind)).toEqual(["file"]);
  });

  it("puts the file that defines a code first, and ends a read with its links", async () => {
    link("loan-period-reference.md", "# Loan periods\n\n## QXA\n\n| QXA | Standard loan |", "Loan periods");
    link("opening-hours-reference.md", "# Calendar\n\nAUM QXA QXA starts in September; see [loans](loan-period-reference.html).", "Calendar");
    link("branch-reference.md", "# Library\n\n[[opening-hours-reference]]", "Library");
    const first = String(await run("topic_search", { query: "QXA" })).split("\n")[0];
    expect(first).toContain("loan-period-reference");
    expect(first).toContain("Loan periods");
    expect(String(await run("topic_source_read", { name: "library-reference/opening-hours-reference.md" }))).toMatch(
      /Links to: library-reference\/loan-period-reference\.md\nLinked from: library-reference\/branch-reference\.md\nPages citing it: none/,
    );
  });

  it("leaves the Index to code while it is generated", async () => {
    link("a.md", "# A");
    store.writeGenerated("Library", "Index", "# Index\n\nmap");
    await expect(run("topic_note_write", { title: "index", text: "mine" })).rejects.toThrow(/made by Vunemi/);
  });

  it("lists pages before files, each group in its own rank", async () => {
    link("loans.md", "loan loan loan rules");
    store.writeNote("Library", { title: "Loan", text: "- loan", by: "vunemi", sources: [] });
    const lines = String(await run("topic_search", { query: "loan" })).split("\n");
    expect(lines[0]).toMatch(/^- note /);
    expect(lines[1]).toMatch(/^- file /);
  });
});
