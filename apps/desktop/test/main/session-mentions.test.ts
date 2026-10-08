/** What "@" brought in is read when the run starts, with the budget of the model about to run. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, MentionRef, RunMention, RunResult } from "@vunemi/agent-core";

const seen: { goal: string; mentions?: RunMention[] }[] = [];
let hold: Promise<void> | null = null;

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({ id: spec, contextWindow: async () => 100_000, chat: async () => ({ text: "", toolCalls: [], usage: {} }) }),
    runAgent: async (opts: { goal: string; mentions?: RunMention[]; history?: ChatMessage[]; emit: (e: AgentEvent) => void }): Promise<RunResult> => {
      seen.push({ goal: opts.goal, ...(opts.mentions && { mentions: opts.mentions }) });
      const runId = `r${seen.length}`;
      opts.emit({ type: "run.started", runId, goal: opts.goal, model: "m", at: 0 });
      if (hold) await hold;
      opts.emit({ type: "run.finished", runId, status: "done", detail: "", at: 0 });
      return { runId, status: "done", detail: "", messages: [...(opts.history ?? []), { role: "user", content: opts.goal }], charsPerToken: real.DEFAULT_CHARS_PER_TOKEN };
    },
  };
});

const { DEFAULT_CHARS_PER_TOKEN } = await import("@vunemi/agent-core");
const { AgentSession } = await import("../../src/main/session.js");

const rome: MentionRef = { kind: "conversation", id: "s_abc123", title: "Rome trip" };

function make() {
  const asked: { refs: MentionRef[]; total: number }[] = [];
  const session = new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: () => {},
    authorize: async () => ({ kind: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
    readMentions: (refs, total) => {
      asked.push({ refs, total });
      return refs.map((ref) => ({ ...ref, date: "2026-10-03", text: `read ${asked.length}` }));
    },
  });
  return { session, asked };
}

const settled = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

beforeEach(() => {
  seen.length = 0;
  hold = null;
});

describe("mentions in a run", () => {
  it("are read with 40% of the model's window and handed to the run", async () => {
    const { session, asked } = make();
    await session.start("Which hotel in @Rome trip?", "lmstudio:m", [], { mentions: [rome] });
    expect(asked).toEqual([{ refs: [rome], total: Math.floor(100_000 * DEFAULT_CHARS_PER_TOKEN * 0.4) }]);
    expect(seen[0]!.mentions).toEqual([{ ...rome, date: "2026-10-03", text: "read 1" }]);
  });

  it("are not read when there are none", async () => {
    const { session, asked } = make();
    await session.start("Hello", "lmstudio:m");
    expect(asked).toEqual([]);
    expect(seen[0]!.mentions).toBeUndefined();
  });

  it("wait in the queue with their message and are read when its turn comes", async () => {
    const { session, asked } = make();
    let release = (): void => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    session.submit("first", "lmstudio:m");
    await settled(() => seen.length === 1);
    const queued = session.submit("then @Rome trip", "lmstudio:m", [], [rome]);
    expect(queued?.mentions).toEqual([rome]);
    expect(asked).toEqual([]); // not read while it waits
    hold = null;
    release();
    await settled(() => seen.length === 2);
    expect(asked).toHaveLength(1);
    expect(seen[1]).toEqual({ goal: "then @Rome trip", mentions: [{ ...rome, date: "2026-10-03", text: "read 1" }] });
  });
});
