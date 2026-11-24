/**
 * Web findings (work/findings.ts): a page per matching item in the
 * conversation's topic, or a tidy note in the conversation when it has none.
 * Synthetic pages and hosts only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@vunemi/i18n";
import type { ToolDef } from "@vunemi/agent-core";
import { WorkStore, conversationScope, projectScope } from "../../src/main/work/store.js";
import { TopicStore } from "../../src/main/topics/store.js";
import { addToNote, createFindingTools, listTitle, moveNoteToTopic, pageText, type Finding } from "../../src/main/work/findings.js";

let base = "";
let work: WorkStore;
let topics: TopicStore;
let here: { conversationId: string; projectId?: string; conversationTitle?: string; topic?: string };
let page: { url: string; title: string } | null;
let found: Array<Finding & { proposedTopic?: string }>;
let tools: ReturnType<typeof createFindingTools>;
const clock = Date.UTC(2026, 10, 24, 10, 30);

const ctx = { runId: "r1", signal: new AbortController().signal } as never;
const tool = (name: string): ToolDef => tools.tools.find((x) => x.name === name)!;
const add = (args: Record<string, unknown>) => tool("web_finding_add").run(args, ctx);

const zone = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "UTC";
  setLocale("en");
  base = mkdtempSync(join(tmpdir(), "vunemi-findings-"));
  work = new WorkStore(join(base, "work"), () => clock);
  topics = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data"), now: () => clock });
  here = { conversationId: "c1", conversationTitle: "Job hunt" };
  page = { url: "https://jobs.example/job/1", title: "Accountant" };
  found = [];
  tools = createFindingTools({
    work,
    topics,
    where: () => here,
    request: () => "Find accountant jobs in London: full time, at least 35,000?",
    page: async () => page,
    sources: () => ["jobs.example"],
    redact: (text) => text.replaceAll("hunter2-secret", "[secret]"),
    onSaved: () => {},
    onFinding: (_runId, f) => found.push(f),
    now: () => clock,
  });
});
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  work.close();
  rmSync(base, { recursive: true, force: true });
});

const noteText = () => work.readNote(conversationScope("c1"), t("findings.noteTitle"))?.text ?? null;

describe("addToNote", () => {
  const f = (over: Partial<Finding>): Finding => ({ request: "jobs in London", title: "Accountant, Acme", text: "40,000; three years", url: "https://jobs.example/1", at: clock, ...over });

  it("puts findings under a heading for their request", () => {
    const one = addToNote(null, f({}), 4_000) as { text: string; added: boolean };
    const two = addToNote(one.text, f({ title: "Auditor, Gamma", url: "https://jobs.example/3" }), 4_000) as { text: string };
    const three = addToNote(two.text, f({ request: "jobs in Leeds", title: "Analyst, Beta", url: "https://jobs.example/2" }), 4_000) as { text: string };
    expect(three.text).toBe(
      "## jobs in London\n- **Accountant, Acme**: 40,000; three years — https://jobs.example/1 (10:30)\n- **Auditor, Gamma**: 40,000; three years — https://jobs.example/3 (10:30)\n\n## jobs in Leeds\n- **Analyst, Beta**: 40,000; three years — https://jobs.example/2 (10:30)",
    );
  });

  it("doesn't add the same item twice", () => {
    const one = addToNote(null, f({}), 4_000) as { text: string };
    expect(addToNote(one.text, f({}), 4_000)).toEqual({ text: one.text, added: false });
  });

  it("writes the time and day where the user is", () => {
    process.env.TZ = "Europe/Istanbul";
    const late = Date.UTC(2026, 10, 24, 22, 30);
    expect((addToNote(null, f({ at: late }), 4_000) as { text: string }).text).toContain("(01:30)");
    expect(pageText(f({ at: late }))).toContain("(2026-11-25)");
  });

  it("keeps two items of the same name from one list page", () => {
    const one = addToNote(null, f({ title: "Python Programmer", text: "Company: Moss; Location: Port Sara" }), 4_000) as { text: string };
    const two = addToNote(one.text, f({ title: "Python Programmer", text: "Company: Cooper; Location: West Victor" }), 4_000) as { text: string; added: boolean };
    expect(two.added).toBe(true);
    expect(two.text.split("\n").filter((l) => l.startsWith("- **Python Programmer**"))).toHaveLength(2);
  });

  it("says it is full instead of cutting anything", () => {
    const one = addToNote(null, f({ text: "x".repeat(300) }), 4_000) as { text: string };
    expect(addToNote(one.text, f({ title: "Other", text: "y".repeat(400) }), 450)).toEqual({ full: true });
  });
});

describe("in a topic", () => {
  beforeEach(() => {
    topics.createTopic("Job hunt", "");
    here = { ...here, topic: "Job hunt" };
  });

  it("makes a page for the item, with the page's address, and lists it on the lookup's page", async () => {
    await add({ title: "Accountant: Acme Ltd", text: "40,000 a year. Three years in practice. See https://elsewhere.example", topic: "Job hunt" });
    const item = topics.readNote("Job hunt", "Accountant Acme Ltd")!;
    expect(item.by).toBe("vunemi");
    expect(item.text).toBe("40,000 a year. Three years in practice. See https://elsewhere.example\n\nSource: https://jobs.example/job/1 (2026-11-24)");
    const list = topics.readNote("Job hunt", "Web findings — Find accountant jobs in London full time, at least 35,000")!;
    expect(list.text).toBe("- [[Accountant Acme Ltd]] — https://jobs.example/job/1");
  });

  it("writes the same item with the same facts once, and lists it once", async () => {
    await add({ title: "Accountant, Acme", text: "40,000" });
    await add({ title: "Accountant, Acme", text: "40,000" });
    expect(topics.listNotes("Job hunt").filter((n) => n.title.startsWith("Accountant"))).toHaveLength(1);
    expect(topics.listNotes("Job hunt").find((n) => n.title.startsWith("Web findings"))!.text.match(/\[\[/g)).toHaveLength(1);
  });

  it("gives a second item of the same name its own page, and says how to change the first", async () => {
    await add({ title: "Python Programmer", text: "Company: Moss; Location: Port Sara" });
    const said = await add({ title: "Python Programmer", text: "Company: Cooper; Location: West Victor" });
    expect(topics.readNote("Job hunt", "Python Programmer")!.text).toContain("Moss");
    expect(topics.readNote("Job hunt", "Python Programmer (2)")!.text).toContain("Cooper");
    expect(said).toContain('Kept "Python Programmer (2)"');
    expect(said).toContain("topic_note_write");
    expect(topics.listNotes("Job hunt").find((n) => n.title.startsWith("Web findings"))!.text.match(/\[\[/g)).toHaveLength(2);
  });

  it("never writes over a page the user wrote", async () => {
    topics.writeNote("Job hunt", { title: "Accountant, Acme", text: "My own notes", by: "user", sources: [] });
    await add({ title: "Accountant, Acme", text: "40,000" });
    expect(topics.readNote("Job hunt", "Accountant, Acme")!.text).toBe("My own notes");
    expect(topics.readNote("Job hunt", "Accountant, Acme (web)")!.text).toContain("40,000");
  });

});

describe("listTitle", () => {
  it("cuts a long request at a word", () => {
    expect(listTitle("Search NHS Jobs (jobs.nhs.uk) for software developer vacancies and list the ones you find.")).toBe(
      "Web findings — Search NHS Jobs (jobs.nhs.uk) for software developer",
    );
    expect(listTitle("Find accountant jobs in London: full time, at least 35,000?")).toBe("Web findings — Find accountant jobs in London full time, at least 35,000");
  });
});

describe("with no topic", () => {
  it("keeps findings in the conversation's note, grouped by request", async () => {
    await add({ title: "Accountant, Acme", text: "40,000" });
    expect(noteText()).toBe("## Find accountant jobs in London: full time, at least 35,000?\n- **Accountant, Acme**: 40,000 — https://jobs.example/job/1 (10:30)");
  });

  it("keeps a first finding in the temporary topic ensureTopic gives, and no note", async () => {
    const asked: string[][] = [];
    tools = createFindingTools({
      work, topics, where: () => here,
      request: () => "Find accountant jobs in London",
      page: async () => page, sources: () => ["jobs.example"], redact: (text) => text,
      onSaved: () => {}, onFinding: () => {}, now: () => clock,
      ensureTopic: (proposed, request) => {
        asked.push([proposed, request]);
        return topics.findTopic("Accountant jobs")?.name ?? topics.createTopic("Accountant jobs", request, { temporary: true }).name;
      },
    });
    expect(await add({ title: "Accountant, Acme", text: "40,000", topic: "Accountant jobs" })).toContain('in the topic "Accountant jobs"');
    expect(asked).toEqual([["Accountant jobs", "Find accountant jobs in London"]]);
    expect(topics.readNote("Accountant jobs", "Accountant, Acme")?.text).toContain("Source: https://jobs.example/job/1");
    expect(noteText()).toBeNull();
  });

  it("keeps the note as before when ensureTopic gives none", async () => {
    tools = createFindingTools({
      work, topics, where: () => here,
      request: () => "Find accountant jobs in London",
      page: async () => page, sources: () => [], redact: (text) => text,
      onSaved: () => {}, onFinding: () => {}, now: () => clock,
      ensureTopic: () => null,
    });
    await add({ title: "Accountant, Acme", text: "40,000" });
    expect(noteText()).toContain("**Accountant, Acme**");
  });

  it("asks the model to rewrite the note shorter when it is full, and changes nothing", async () => {
    for (let i = 0; i < 7; i++) await add({ title: `Job ${i}`, text: "z".repeat(490) });
    const before = noteText();
    await expect(add({ title: "Job 99", text: "z".repeat(490) })).rejects.toThrow('The findings note is full. Rewrite it shorter with worknote_write under the title "Web findings", in the same form, keeping what matters to the request; then add this finding again.');
    expect(noteText()).toBe(before);
  });

  it("keeps two conversations of one project apart", async () => {
    here = { conversationId: "c1", projectId: "p1", conversationTitle: "London" };
    await add({ title: "Accountant, Acme", text: "40,000" });
    here = { conversationId: "c2", projectId: "p1", conversationTitle: "Leeds" };
    await add({ title: "Analyst, Beta", text: "35,000" });
    const titles = work.listNotes(projectScope("p1")).map((n) => n.title).sort();
    expect(titles).toEqual([`${t("findings.noteTitle")} — Leeds`, `${t("findings.noteTitle")} — London`]);
    work.forgetConversation("c1");
    expect(work.listNotes(projectScope("p1"))).toHaveLength(2);
  });

  it("moves the note's findings into a topic as pages, then removes the note", async () => {
    await add({ title: "Accountant, Acme", text: "40,000" });
    page = { url: "https://jobs.example/job/2", title: "Analyst" };
    await add({ title: "Analyst, Beta", text: "35,000" });
    page = { url: "https://jobs.example/job/3", title: "Auditor" };
    await add({ title: "Auditor, Gamma", text: "45,000" });
    topics.createTopic("Job hunt", "");
    expect(moveNoteToTopic(work, topics, here, "Job hunt", () => clock)).toBe(3);
    expect(topics.readNote("Job hunt", "Analyst, Beta")!.text).toBe("35,000\n\nSource: https://jobs.example/job/2 (2026-11-24)");
    expect(topics.listNotes("Job hunt").find((n) => n.title.startsWith("Web findings"))!.text.split("\n")).toHaveLength(3);
    expect(noteText()).toBeNull();
  });

  it("moves a project conversation's findings, named with its title, through the tools' own place", async () => {
    here = { conversationId: "c1", projectId: "p1", conversationTitle: "London" };
    await add({ title: "Accountant, Acme", text: "40,000" });
    topics.createTopic("Job hunt", "");
    expect(tools.moveToTopic("Job hunt")).toBe(1);
    expect(topics.readNote("Job hunt", "Accountant, Acme")).not.toBeNull();
    expect(work.listNotes(projectScope("p1"))).toHaveLength(0);
  });

  it("keeps the note when it holds lines it can't read as findings, so nothing is lost", async () => {
    await add({ title: "Accountant, Acme", text: "40,000" });
    const note = work.readNote(conversationScope("c1"), t("findings.noteTitle"))!;
    work.writeNote({ scope: conversationScope("c1"), conversationId: "c1", title: note.title, text: `${note.text}\nBest so far: Acme, the only one with hybrid work.`, sources: [] });
    topics.createTopic("Job hunt", "");
    expect(moveNoteToTopic(work, topics, here, "Job hunt", () => clock)).toBe(1);
    expect(topics.readNote("Job hunt", "Accountant, Acme")).not.toBeNull();
    expect(noteText()).toContain("Best so far: Acme");
  });
});

describe("either way", () => {
  it("refuses a finding with no page open, and saves nothing", async () => {
    page = null;
    await expect(add({ title: "Accountant", text: "40,000" })).rejects.toThrow("Open the page this finding comes from, then add it.");
    expect(noteText()).toBeNull();
  });

  it("refuses a long title or text, with the limit", async () => {
    await expect(add({ title: "t".repeat(81), text: "x" })).rejects.toThrow(/80/);
    await expect(add({ title: "t", text: "x".repeat(501) })).rejects.toThrow(/500/);
  });

  it("masks stored secrets and key shapes", async () => {
    await add({ title: "Portal", text: "login hunter2-secret token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD" });
    expect(noteText()).toContain("[secret]");
    expect(noteText()).not.toContain("hunter2-secret");
    expect(noteText()).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  });

  it("says what it kept with the page's address, as the agent reads it for checkpoints", async () => {
    expect(await add({ title: "Accountant, Acme", text: "40,000" })).toMatch(/^Kept "Accountant, Acme" \(https:\/\/jobs\.example\/job\/1\) /);
    topics.createTopic("Job hunt", "");
    here = { ...here, topic: "Job hunt" };
    expect(await add({ title: "Auditor: Gamma", text: "45,000" })).toMatch(/^Kept "Auditor Gamma" \(https:\/\/jobs\.example\/job\/1\) /);
  });

  it("tells who asked what was found, and keeps this run's findings", async () => {
    await add({ title: "Accountant, Acme", text: "40,000", topic: "Job hunt" });
    expect(found).toEqual([expect.objectContaining({ title: "Accountant, Acme", url: "https://jobs.example/job/1", proposedTopic: "Job hunt" })]);
    await add({ title: "Analyst, Beta", text: "35,000", topic: "Python jobs (realpython.github.io/fake-jobs)" });
    // Whole, for the question to shorten at a word (topics/findings-ask.ts).
    expect(found.at(-1)!.proposedTopic).toBe("Python jobs (realpython.github.io/fake-jobs)");
    expect(tools.runFindings("r1")).toEqual([expect.objectContaining({ title: "Accountant, Acme" }), expect.objectContaining({ title: "Analyst, Beta" })]);
    expect(tools.runFindings("other")).toEqual([]);
  });
});

describe("findingsOption", () => {
  it("is given to a run only while the findings tool is offered", async () => {
    const { ToolRegistry } = await import("@vunemi/agent-core");
    const { findingsOption } = await import("../../src/main/work/findings.js");
    const registry = new ToolRegistry();
    expect(findingsOption(registry)).toBeUndefined();
    registry.register(tools.tools[0]!);
    const option = findingsOption(registry)!;
    expect(option.tool).toBe("web_finding_add");
    expect([...option.pages].sort()).toEqual(["page_back", "page_click", "page_describe", "page_goto", "page_read", "page_scroll"]);
  });
});
