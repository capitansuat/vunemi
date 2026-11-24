/** After a lookup: ask once to keep what was found in a topic, a fitting one or a new one (topics/findings-ask.ts). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@vunemi/i18n";
import { WorkStore, conversationScope } from "../../src/main/work/store.js";
import { TopicStore } from "../../src/main/topics/store.js";
import { createFindingTools } from "../../src/main/work/findings.js";
import { acceptAsk, asksAfter, whichAsk } from "../../src/main/topics/findings-ask.js";

const REQUEST = "Find accountant jobs in London: full time?";

describe("whichAsk", () => {
  const base = { inTopic: false, asked: false, request: REQUEST, fitting: null };
  it("offers a new topic under the proposed name when findings were kept and none fits", () => {
    expect(whichAsk({ ...base, found: [{}, { proposedTopic: "Job hunt" }] })).toEqual({ topic: "Job hunt", new: true });
  });
  it("names it from the request when the model proposed none, cleaned for a folder", () => {
    expect(whichAsk({ ...base, found: [{}] })).toEqual({ topic: "Find accountant jobs in London full time", new: true });
  });
  it("asks for a fitting topic as today, findings or not", () => {
    expect(whichAsk({ ...base, fitting: "Career", found: [{ proposedTopic: "Job hunt" }] })).toEqual({ topic: "Career" });
    expect(whichAsk({ ...base, fitting: "Career", found: undefined })).toEqual({ topic: "Career" });
  });
  it("asks nothing in a topic, once asked, or with nothing found and nothing fitting", () => {
    expect(whichAsk({ ...base, inTopic: true, found: [{}] })).toBeNull();
    expect(whichAsk({ ...base, asked: true, found: [{}] })).toBeNull();
    expect(whichAsk({ ...base, found: undefined })).toBeNull();
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

  it("makes the new topic, puts the conversation in it, and moves the findings into pages", () => {
    expect(acceptAsk({ topic: "Job hunt", new: true }, deps())).toBe("Job hunt");
    expect(topics.findTopic("Job hunt")?.name).toBe("Job hunt");
    expect(linked).toEqual(["Job hunt"]);
    expect(topics.readNote("Job hunt", "Accountant, Acme")!.text).toContain("Source: https://jobs.example/job/1");
    expect(work.readNote(conversationScope("c1"), t("findings.noteTitle"))).toBeNull();
  });

  it("uses a topic of that name if there already is one", () => {
    topics.createTopic("Job hunt", "mine");
    expect(acceptAsk({ topic: "job hunt", new: true }, deps())).toBe("Job hunt");
    expect(topics.listTopics()).toHaveLength(1);
  });

  it("falls back to the request's words when the proposed name can't be a folder", () => {
    expect(acceptAsk({ topic: "Jobs/London", new: true }, deps())).toBe("Find accountant jobs in London full time");
  });

  it("moves the findings into a fitting topic too", () => {
    topics.createTopic("Career", "");
    expect(acceptAsk({ topic: "Career" }, deps())).toBe("Career");
    expect(topics.readNote("Career", "Accountant, Acme")).not.toBeNull();
  });
});
