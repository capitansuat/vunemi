/**
 * Compaction after a task: the session makes room in what the model will
 * read next, while the user reads the answer, and never makes them wait
 * for it when they ask it to stop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, RunResult } from "@ocak/agent-core";

const summary = ["## User's goals", "## Facts learned", "## Done so far", "## Errors and fixes", "## Still pending"].map((s) => `${s}\n- x`).join("\n\n");
const runs: { history: ChatMessage[]; finish: (r: Partial<RunResult>) => void }[] = [];
let summaryGate: Promise<void> = Promise.resolve();
let summaryCalls = 0;

vi.mock("@ocak/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ocak/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({
      id: spec,
      // Big enough that the system prompt (~1.7K chars) is a small part of it.
      contextWindow: async () => 20_000,
      chat: async (req: { signal: AbortSignal }) => {
        summaryCalls++;
        await Promise.race([
          summaryGate,
          new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason))),
        ]);
        return { text: summary, toolCalls: [], usage: { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null } };
      },
    }),
    runAgent: (opts: { goal: string; history?: ChatMessage[]; emit: (e: AgentEvent) => void }) =>
      new Promise<RunResult>((resolve) => {
        const runId = `r${runs.length + 1}`;
        opts.emit({ type: "run.started", runId, goal: opts.goal, model: "m", at: 0 });
        runs.push({
          history: opts.history ?? [],
          finish: (r) => {
            opts.emit({ type: "run.finished", runId, status: r.status ?? "done", detail: "", at: 0 });
            resolve({ runId, status: "done", detail: "", messages: [], charsPerToken: 1, ...r });
          },
        });
      }),
  };
});

const { AgentSession } = await import("../../src/main/session.js");

const turn = (n: number, size: number): ChatMessage[] => [
  { role: "user", content: `<user_request>\nu${n}\n</user_request>` },
  { role: "assistant", content: "a".repeat(size) },
];

function makeSession() {
  const events: AgentEvent[] = [];
  const histories: ChatMessage[][] = [];
  const session = new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: (e) => events.push(e),
    authorize: async () => ({ kind: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
    redact: (text) => text.replace("x", "•"),
    onHistory: (h) => histories.push(h),
  });
  return { session, events, histories };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("compaction after a task", () => {
  beforeEach(() => {
    runs.length = 0;
    summaryCalls = 0;
    summaryGate = Promise.resolve();
  });

  it("leaves a short conversation alone", async () => {
    const { session, events } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ messages: turn(1, 10) });
    await done;
    expect(events.some((e) => e.type.startsWith("context."))).toBe(false);
    expect(summaryCalls).toBe(0);
  });

  // The mocked run reports 1 char/token, so 60% of 20 000 tokens is 12 000 chars:
  // ~1.7K of system prompt plus 12K of turns crosses it; the summary brings it under 10K.
  it("summarizes past 60% of the window, keeps the last two turns, and says so", async () => {
    const { session, events, histories } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ messages: [...turn(1, 6_000), ...turn(2, 3_000), ...turn(3, 3_000)] });
    await done;
    expect(summaryCalls).toBe(1);
    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted).toMatchObject({ runId: "r1", kind: "summarized", window: 20_000 });
    expect((compacted as { summary: string }).summary).toContain("•");
    const kept = histories.at(-1)!;
    expect(kept.filter((m) => m.role === "user")).toHaveLength(2);
    expect(kept[0]!.content.startsWith("<earlier_summary>")).toBe(true);
    expect(events.findIndex((e) => e.type === "context.compacting")).toBeLessThan(events.findIndex((e) => e.type === "context.compacted"));
  });

  it("holds a message sent while summarizing, and starts it after", async () => {
    let open!: () => void;
    summaryGate = new Promise((r) => (open = r));
    const { session } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ messages: [...turn(1, 6_000), ...turn(2, 3_000), ...turn(3, 3_000)] });
    await settle();
    expect(session.submit("next", "lmstudio:m")).not.toBeNull(); // queued, not started
    expect(runs).toHaveLength(1);
    open();
    await done;
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.history[0]!.content.startsWith("<earlier_summary>")).toBe(true);
  });

  it("stop cancels the summary, keeps what trimming gave, and lets the next message go", async () => {
    summaryGate = new Promise(() => {});
    const { session, events } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ messages: [...turn(1, 6_000), ...turn(2, 3_000), ...turn(3, 3_000)] });
    await settle();
    session.submit("next", "lmstudio:m");
    session.stop();
    await done;
    await settle();
    expect(events.find((e) => e.type === "context.compacted")).toMatchObject({ kind: "unchanged" });
    expect(runs).toHaveLength(2);
  });

  it("does not summarize after a stopped task", async () => {
    const { session } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ status: "stopped", messages: [...turn(1, 6_000), ...turn(2, 3_000), ...turn(3, 3_000)] });
    await done;
    expect(summaryCalls).toBe(0);
  });

  it("compacts on request, and reports the window and estimate", async () => {
    const { session, events } = makeSession();
    const done = session.start("hi", "lmstudio:m");
    await settle();
    runs[0]!.finish({ messages: [...turn(1, 50), ...turn(2, 50), ...turn(3, 50)] });
    await done;
    expect(await session.contextInfo("lmstudio:m")).toMatchObject({ window: 20_000, known: true });
    await session.compactNow("lmstudio:m", "r1");
    expect(events.find((e) => e.type === "context.compacted")).toMatchObject({ kind: "summarized", runId: "r1" });
  });
});

describe("a task that ran out of steps", () => {
  beforeEach(() => {
    runs.length = 0;
    summaryCalls = 0;
    summaryGate = Promise.resolve();
  });

  it("is kept, so asking to continue continues from its work", async () => {
    const { session } = makeSession();
    const done = session.start("research", "lmstudio:m");
    await settle();
    const work = turn(1, 50);
    runs[0]!.finish({ status: "max_steps", messages: work });
    await done;
    const next = session.start("devam et", "lmstudio:m");
    await settle();
    expect(runs[1]!.history).toEqual(work);
    runs[1]!.finish({});
    await next;
  });
});
