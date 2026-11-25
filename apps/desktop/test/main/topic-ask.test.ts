/** After a lookup: ask once to keep what was found in a topic, a fitting one or a new one (topics/findings-ask.ts). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@vunemi/i18n";
import { WorkStore, conversationScope } from "../../src/main/work/store.js";
import { TopicStore } from "../../src/main/topics/store.js";
import { createFindingTools } from "../../src/main/work/findings.js";
import { acceptAsk, asksAfter, deleteAsk, keepAsk, suggestable, whichAsk } from "../../src/main/topics/findings-ask.js";

const REQUEST = "Find accountant jobs in London: full time?";

describe("whichAsk", () => {
  const base = { inTopic: false, asked: false, request: REQUEST, fitting: null };
  it("still asks about a fitting topic for a conversation with no lookup", () => {
    expect(whichAsk({ ...base, fitting: "Career" })).toEqual({ topic: "Career" });
  });
  it("asks nothing in a topic, once asked, or with nothing fitting: a lookup gathers in a temporary topic instead", () => {
    expect(whichAsk({ ...base, inTopic: true, fitting: "Career" })).toBeNull();
    expect(whichAsk({ ...base, asked: true, fitting: "Career" })).toBeNull();
    expect(whichAsk(base)).toBeNull();
  });
});

describe("suggestable", () => {
  it("never offers a temporary topic for another conversation", () => {
    const list = [{ name: "Career", temporary: undefined }, { name: "Job hunt", temporary: true as const }];
    expect(suggestable(list).map((x) => x.name)).toEqual(["Career"]);
  });
});

describe("asksAfter", () => {
  it("asks after a finished task, and after one that ran out of steps only when it kept findings", () => {
    expect(asksAfter("done", undefined)).toBe(true);
    expect(asksAfter("max_steps", [{}])).toBe(true);
    expect(asksAfter("max_steps", undefined)).toBe(false);
    expect(asksAfter("max_steps", [])).toBe(false);
  });
});

describe("acceptAsk", () => {
  let dir = "";
  let work: WorkStore;
  let topics: TopicStore;
  let linked: string[];
  let move: (name: string) => number;
  const where = { conversationId: "c1" };
  const clock = Date.UTC(2026, 10, 24, 10, 30);

  beforeEach(async () => {
    setLocale("en");
    dir = mkdtempSync(join(tmpdir(), "vunemi-ask-"));
    work = new WorkStore(join(dir, "work"), () => clock);
    topics = new TopicStore({ root: () => join(dir, "Memory"), dataDir: join(dir, "data"), now: () => clock });
    linked = [];
    const made = createFindingTools({
      work, topics, where: () => where, request: () => REQUEST, page: async () => ({ url: "https://jobs.example/job/1", title: "Accountant" }),
      sources: () => [], redact: (x) => x, onSaved: () => {}, onFinding: () => {}, now: () => clock,
    });
    move = made.moveToTopic;
    await made.tools[0]!.run({ title: "Accountant, Acme", text: "40,000" }, { runId: "r1" } as never);
  });
  afterEach(() => {
    work.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const deps = () => ({ topics, request: REQUEST, link: (name: string) => linked.push(name), move });

  it("moves the findings into a fitting topic too", () => {
    topics.createTopic("Career", "");
    expect(acceptAsk({ topic: "Career" }, deps())).toBe("Career");
    expect(topics.readNote("Career", "Accountant, Acme")).not.toBeNull();
  });
});

describe("the temporary topic's card", () => {
  let dir = "";
  let topics: TopicStore;
  let renamed: [string, string][];
  let trashed: string[];
  let declined: number;
  const held = { topic: "Job hunt", temporary: true as const };

  beforeEach(() => {
    setLocale("en");
    dir = mkdtempSync(join(tmpdir(), "vunemi-ask-temp-"));
    topics = new TopicStore({ root: () => join(dir, "Memory"), dataDir: join(dir, "data") });
    topics.createTopic("Job hunt", "Find Python jobs", { temporary: true });
    topics.writeNote("Job hunt", { title: "Found — Find Python jobs", text: "Two jobs", by: "vunemi", sources: [] });
    renamed = [];
    trashed = [];
    declined = 0;
  });
  afterEach(() => {
    topics.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const keep = (name?: string) => keepAsk(held, { topics, ...(name !== undefined && { name }), rename: (from, to) => renamed.push([from, to]) });

  it("keepAsk keeps it under its name: the mark goes, nothing is renamed", () => {
    expect(keep()).toBe("Job hunt");
    expect(topics.findTopic("Job hunt")?.temporary).toBeUndefined();
    expect(renamed).toEqual([]);
  });

  it("keepAsk keeps it under the name typed, and the conversation follows", () => {
    expect(keep("Python jobs")).toBe("Python jobs");
    expect(renamed).toEqual([["Job hunt", "Python jobs"]]);
    expect(topics.readNote("Python jobs", "Found — Find Python jobs")?.text).toBe("Two jobs");
  });

  it("keepAsk refuses a taken name and changes nothing", () => {
    topics.createTopic("Career", "");
    expect(() => keep("career")).toThrow(/already a topic/);
    expect(topics.findTopic("Job hunt")?.temporary).toBe(true);
    expect(renamed).toEqual([]);
  });

  it("deleteAsk trashes the folder and marks the conversation declined", async () => {
    await deleteAsk(held, { trash: async (topic) => { trashed.push(topic); }, decline: () => declined++ });
    expect(trashed).toEqual(["Job hunt"]);
    expect(declined).toBe(1);
  });

  it("deleteAsk marks nothing when the Trash refuses", async () => {
    await expect(deleteAsk(held, { trash: async () => { throw new Error("no Trash"); }, decline: () => declined++ })).rejects.toThrow("no Trash");
    expect(declined).toBe(0);
  });
});
