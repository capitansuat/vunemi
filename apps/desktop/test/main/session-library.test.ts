/** The lines about earlier conversations go with a request once, and not where nobody asked about the past. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, RunResult } from "@vunemi/agent-core";

const seen: (string | null)[] = [];
let status: RunResult["status"] = "done";

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({ id: spec, contextWindow: async () => 100_000, chat: async () => ({ text: "", toolCalls: [], usage: {} }) }),
    runAgent: async (opts: { goal: string; libraryIndex?: string; history?: ChatMessage[]; emit: (e: AgentEvent) => void }): Promise<RunResult> => {
      seen.push(opts.libraryIndex ?? null);
      const runId = `r${seen.length}`;
      opts.emit({ type: "run.started", runId, goal: opts.goal, model: "m", at: 0 });
      opts.emit({ type: "run.finished", runId, status, detail: "", at: 0 } as AgentEvent);
      return { runId, status, detail: "", messages: [...(opts.history ?? []), { role: "user", content: opts.goal }], charsPerToken: 1 };
    },
  };
});

const { AgentSession } = await import("../../src/main/session.js");

const make = (given: string[][]) =>
  new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: () => {},
    authorize: async () => ({ kind: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
    libraryIndex: async (_goal, already) => {
      given.push([...already]);
      return already.has("s_a") ? null : { text: "INDEX a", ids: ["s_a"] };
    },
  });

beforeEach(() => {
  seen.length = 0;
  status = "done";
});

describe("library index in a conversation", () => {
  it("is told what the conversation was given before, and starts over in a new one", async () => {
    const given: string[][] = [];
    const session = make(given);
    await session.start("ilk", "lmstudio:m");
    await session.start("ikinci", "lmstudio:m");
    session.reset();
    await session.start("yeni", "lmstudio:m");
    expect(seen).toEqual(["INDEX a", null, "INDEX a"]);
    expect(given).toEqual([[], ["s_a"], []]);
  });

  it("gives the lines again after a task that failed with them", async () => {
    const given: string[][] = [];
    const session = make(given);
    status = "failed";
    await session.start("ilk", "lmstudio:m");
    status = "done";
    await session.start("ikinci", "lmstudio:m");
    expect(seen).toEqual(["INDEX a", "INDEX a"]);
  });

  it("is not asked for a scheduled task", async () => {
    const given: string[][] = [];
    const session = make(given);
    await session.start("zamanlı", "lmstudio:m", [], { unattended: true });
    expect(seen).toEqual([null]);
    expect(given).toEqual([]);
  });

  it("goes on without the lines when finding them fails", async () => {
    const session = new AgentSession({
      tools: { list: () => [], get: () => undefined, register: () => {} } as never,
      emit: () => {},
      authorize: async () => ({ kind: "allow" }) as never,
      onUntrustedOutput: () => {},
      grants: new Set<string>(),
      libraryIndex: async () => { throw new Error("db locked"); },
    });
    await session.start("ilk", "lmstudio:m");
    expect(seen).toEqual([null]);
  });
});
