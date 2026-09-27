/**
 * The session and the built-in engine: a run loads its model first, and a
 * window the engine could not report yet (it was not running) is asked for
 * again rather than remembered.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, RunResult } from "@vunemi/agent-core";

const order: string[] = [];
let windowAnswers: (number | null)[] = [];

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({
      id: spec,
      contextWindow: async () => (windowAnswers.length > 0 ? windowAnswers.shift()! : null),
      chat: async () => {
        throw new Error("not used");
      },
    }),
    runAgent: async (opts: { goal: string; emit: (e: AgentEvent) => void }): Promise<RunResult> => {
      order.push("run");
      opts.emit({ type: "run.started", runId: "r1", goal: opts.goal, model: "m", at: 0 });
      opts.emit({ type: "run.finished", runId: "r1", status: "failed", detail: "", at: 0 });
      return { runId: "r1", status: "failed", detail: "", messages: [], charsPerToken: 3 };
    },
  };
});

const { AgentSession } = await import("../../src/main/session.js");

function makeSession(prepareModel?: (spec: string) => Promise<void>) {
  return new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: () => {},
    authorize: async () => ({ kind: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
    ...(prepareModel && { prepareModel }),
  });
}

describe("getting the model ready", () => {
  it("prepares the model before the run starts", async () => {
    order.length = 0;
    const session = makeSession(async (spec) => {
      order.push(`prepare ${spec}`);
    });
    await session.start("hi", "vunemi:m");
    expect(order).toEqual(["prepare vunemi:m", "run"]);
  });

  it("still runs, and fails as unreachable, when the model could not be loaded", async () => {
    order.length = 0;
    const session = makeSession(async () => {
      throw new Error("no memory");
    });
    await session.start("hi", "vunemi:m");
    expect(order).toEqual(["run"]);
  });

  it("can be stopped while the model loads", async () => {
    order.length = 0;
    const session = makeSession(() => new Promise<void>(() => {}));
    const running = session.start("hi", "vunemi:m");
    await new Promise((r) => setTimeout(r, 5));
    session.stop();
    await running;
    expect(order).toEqual(["run"]);
  });

  it("asks again for a window it could not read", async () => {
    windowAnswers = [null, 65_536];
    const session = makeSession();
    expect(await session.contextInfo("vunemi:m")).toMatchObject({ known: false });
    expect(await session.contextInfo("vunemi:m")).toMatchObject({ window: 65_536, known: true });
  });
});
