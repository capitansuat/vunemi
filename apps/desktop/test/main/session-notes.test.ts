/** The notes index goes with a conversation's first request, and only with it. */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, RunResult } from "@vunemi/agent-core";

const seen: { goal: string; notesIndex?: string }[] = [];

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({ id: spec, contextWindow: async () => 100_000, chat: async () => ({ text: "", toolCalls: [], usage: {} }) }),
    runAgent: async (opts: { goal: string; notesIndex?: string; history?: ChatMessage[]; emit: (e: AgentEvent) => void }): Promise<RunResult> => {
      seen.push({ goal: opts.goal, ...(opts.notesIndex && { notesIndex: opts.notesIndex }) });
      const runId = `r${seen.length}`;
      opts.emit({ type: "run.started", runId, goal: opts.goal, model: "m", at: 0 });
      opts.emit({ type: "run.finished", runId, status: "done", detail: "", at: 0 });
      return { runId, status: "done", detail: "", messages: [...(opts.history ?? []), { role: "user", content: opts.goal }], charsPerToken: 1 };
    },
  };
});

const { AgentSession } = await import("../../src/main/session.js");

describe("notes index in a conversation", () => {
  it("is given with the first request, not the next, and again after a new conversation", async () => {
    let asked = 0;
    const session = new AgentSession({
      tools: { list: () => [], get: () => undefined, register: () => {} } as never,
      emit: () => {},
      authorize: async () => ({ kind: "allow" }) as never,
      onUntrustedOutput: () => {},
      grants: new Set<string>(),
      notesIndex: () => {
        asked++;
        return "INDEX";
      },
    });
    await session.start("ilk", "lmstudio:m");
    await session.start("ikinci", "lmstudio:m");
    session.reset();
    await session.start("yeni konuşma", "lmstudio:m");
    expect(seen.map((s) => s.notesIndex ?? null)).toEqual(["INDEX", null, "INDEX"]);
    expect(asked).toBe(2);
  });
});
