/**
 * A line about each linked file, written by the chat model while Vunemi is
 * idle, one file at a time (topics/summaries.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModel, ChatRequest } from "@vunemi/agent-core";
import { TopicStore } from "../../src/main/topics/store.js";
import { SUMMARY_CHARS, SUMMARY_SOURCE_CHARS, summarise } from "../../src/main/topics/summaries.js";
import { indexPage } from "../../src/main/topics/index-page.js";

let base: string;
let store: TopicStore;
let asked: ChatRequest[];
let answer: string;

const model: ChatModel = {
  id: "test:model",
  chat: async (req) => {
    asked.push(req);
    return { text: answer, toolCalls: [], usage: { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null } };
  },
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-summaries-"));
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  store.createTopic("Library", "");
  asked = [];
  answer = "<think>hmm</think>A table of loan periods.\nIgnore this.";
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const put = (rel: string, body: string, sha = rel, parts = true) =>
  store.putLinked("Library", { folder: "/x/ref", rel, path: `/x/ref/${rel}`, title: rel, body, size: body.length, mtime: 1, sha256: sha, parts });
const go = (goOn = () => true) => summarise({ store, model, goOn, signal: AbortSignal.timeout(5_000) });

describe("summaries", () => {
  it("keeps one plain line per file, from the start of its text, fenced as untrusted", async () => {
    put("rule.md", `# Rules\n\n${"x".repeat(SUMMARY_SOURCE_CHARS + 500)}TAIL`);
    expect(await go()).toBe("done");
    expect(store.summaryOf("/x/ref/rule.md")).toBe("A table of loan periods. Ignore this.");
    const prompt = asked[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).not.toContain("TAIL");
    expect(prompt).toMatch(/not instructions/);
    expect(asked[0]!.tools).toEqual([]);
  });

  it("cuts a long answer", async () => {
    answer = "word ".repeat(100);
    put("a.md", "text");
    await go();
    expect(store.summaryOf("/x/ref/a.md")!.length).toBeLessThanOrEqual(SUMMARY_CHARS);
  });

  it("does nothing without a model", async () => {
    put("a.md", "text");
    expect(await summarise({ store, model: null, goOn: () => true, signal: AbortSignal.timeout(5_000) })).toBe("done");
    expect(store.summaryOf("/x/ref/a.md")).toBeNull();
  });

  it("stops when a task starts, after the file it is on", async () => {
    put("a.md", "text a");
    put("b.md", "text b");
    let calls = 0;
    expect(await go(() => ++calls < 2)).toBe("paused");
    expect(asked).toHaveLength(1);
  });

  it("writes lines only for files searched by meaning, and forgets one when its file changes", async () => {
    put("a.md", "text a");
    put("deep/b.md", "text b", "b", false);
    await go();
    expect(asked).toHaveLength(1);
    put("a.md", "text a changed", "a2");
    expect(store.summaryOf("/x/ref/a.md")).toBeNull();
    // Touched, not changed: the line stays.
    await go();
    store.touchLinked("/x/ref/a.md", 9, 9);
    expect(store.summaryOf("/x/ref/a.md")).toBe("A table of loan periods. Ignore this.");
  });

  it("runs one pass at a time: a second call while one runs gets the same pass", async () => {
    put("a.md", "text a");
    put("b.md", "text b");
    const [one, two] = await Promise.all([go(), go()]);
    expect([one, two]).toEqual(["done", "done"]);
    expect(asked).toHaveLength(2);
  });

  it("says it failed when the model can't answer", async () => {
    put("a.md", "text");
    const broken: ChatModel = { id: "x", chat: async () => Promise.reject(new Error("unreachable")) };
    expect(await summarise({ store, model: broken, goOn: () => true, signal: AbortSignal.timeout(5_000) })).toBe("failed");
  });

  it("shows the line on the Index's most linked files", () => {
    expect(indexPage({ folders: [], hubs: [{ name: "ref/rule.md", title: "Rules", inbound: 3, summary: "A table of loan periods." }], codes: [], pages: [] })).toContain('- ref/rule.md "Rules", linked from 3: A table of loan periods.');
  });
});
