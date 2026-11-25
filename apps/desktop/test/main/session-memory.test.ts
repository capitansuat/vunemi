/**
 * Memory in a conversation: each request is given its notes, the answer
 * says which, and a finished task the user watched is offered for proposals.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, RunResult, RunStatus } from "@vunemi/agent-core";

const seen: { goal: string; memory?: string[] }[] = [];
let nextStatus: RunStatus = "done";

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({ id: spec, contextWindow: async () => 100_000, chat: async () => ({ text: "", toolCalls: [], usage: {} }) }),
    runAgent: async (opts: { goal: string; memory?: string[]; history?: ChatMessage[]; emit: (e: AgentEvent) => void }): Promise<RunResult> => {
      seen.push({ goal: opts.goal, ...(opts.memory && { memory: opts.memory }) });
      const runId = `r${seen.length}`;
      opts.emit({ type: "run.started", runId, goal: opts.goal, model: "m", at: 0 });
      opts.emit({ type: "run.finished", runId, status: nextStatus, detail: "", at: 0 });
      // A finished run ends on its answer; one that ran out of steps, on a tool's result.
      const end: ChatMessage[] = nextStatus === "done" ? [{ role: "assistant", content: ` Found: ${opts.goal} ` }] : [{ role: "tool", content: "page", toolCallId: "c", toolName: "page_read" }];
      return { runId, status: nextStatus, detail: "", messages: [...(opts.history ?? []), { role: "user", content: opts.goal }, ...end], charsPerToken: 1 };
    },
  };
});

const { AgentSession } = await import("../../src/main/session.js");

function makeSession(recall = async (_goal: string) => ({
  notes: [{ id: "g", text: "Reply briefly", kind: "general" as const }, { id: "t", text: "Manager is Ayşe", kind: "topic" as const }],
  topic: ["Manager is Ayşe"],
})) {
  const events: AgentEvent[] = [];
  const after: { runId: string; words: string[]; status: RunStatus; answer: string }[] = [];
  const session = new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: (e) => events.push(e),
    authorize: async () => ({ kind: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
    recall,
    afterRun: ({ runId, words, status, answer }) => after.push({ runId, words, status, answer }),
  });
  return { session, events, after };
}

describe("memory in a conversation", () => {
  it("announces the notes right after the run starts and sends topic notes with the request once", async () => {
    seen.length = 0;
    nextStatus = "done";
    const { session, events } = makeSession();
    await session.start("Ayşe'ye yaz", "lmstudio:m");
    expect(events.map((e) => e.type)).toEqual(["run.started", "memory.given", "run.finished"]);
    expect(events[1]).toMatchObject({ runId: "r1", notes: [{ id: "g" }, { id: "t" }] });
    expect(seen[0]!.memory).toEqual(["Manager is Ayşe"]);
    await session.start("Ayşe'ye tekrar yaz", "lmstudio:m");
    expect(seen[1]!.memory).toBeUndefined(); // already in the conversation
    session.reset();
    await session.start("Ayşe", "lmstudio:m");
    expect(seen[2]!.memory).toEqual(["Manager is Ayşe"]);
  });

  it("runs without memory when recall fails", async () => {
    seen.length = 0;
    nextStatus = "done";
    const { session, events } = makeSession(async () => { throw new Error("db"); });
    expect(await session.start("hi", "lmstudio:m")).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"]);
  });

  it("offers a finished task the user watched for proposals, with their last three messages", async () => {
    seen.length = 0;
    nextStatus = "done";
    const { session, after } = makeSession();
    for (const goal of ["one", "two", "three", "four"]) await session.start(goal, "lmstudio:m");
    expect(after.at(-1)).toEqual({ runId: "r4", words: ["two", "three", "four"], status: "done", answer: "Found: four" });
    expect(session.userWords()).toEqual(["two", "three", "four"]);
    await session.start("five", "lmstudio:m", [], { unattended: true });
    expect(after).toHaveLength(4);
    nextStatus = "failed";
    await session.start("six", "lmstudio:m");
    expect(after).toHaveLength(4);
  });

  it("also tells of a watched task that ran out of steps, with its status, for what it kept", async () => {
    seen.length = 0;
    nextStatus = "max_steps";
    const { session, after } = makeSession();
    await session.start("look through the jobs", "lmstudio:m");
    // No answer text at the end: none is passed on, not an earlier run's.
    expect(after).toEqual([{ runId: "r1", words: ["look through the jobs"], status: "max_steps", answer: "" }]);
    nextStatus = "stopped";
    await session.start("stop", "lmstudio:m");
    expect(after).toHaveLength(1);
  });
});
