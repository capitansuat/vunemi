/**
 * The message queue. Typing while the agent works is the normal case, not an
 * error, and what matters here is the order things happen in: a waiting
 * message starts by itself when the run ends, an interruption jumps the line,
 * and an emergency stop leaves nothing behind that could start on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatMessage, RunResult } from "@ocak/agent-core";

/** One fake run per start; the test decides when and how each one ends. */
const runs: {
  goal: string;
  model: string;
  /** What the session handed this run as the conversation so far. */
  history: ChatMessage[];
  signal: AbortSignal;
  finish: (result: Partial<RunResult>) => void;
}[] = [];

vi.mock("@ocak/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ocak/agent-core")>();
  return {
    ...real,
    createModel: (spec: string) => ({ id: spec }),
    runAgent: (opts: {
      goal: string;
      model: { id: string };
      history?: ChatMessage[];
      signal: AbortSignal;
      emit: (e: AgentEvent) => void;
    }) =>
      new Promise<RunResult>((resolve) => {
        const runId = `r${runs.length + 1}`;
        opts.emit({ type: "run.started", runId, goal: opts.goal, model: opts.model.id, at: Date.now() });
        runs.push({
          goal: opts.goal,
          model: opts.model.id,
          history: opts.history ?? [],
          signal: opts.signal,
          finish: (result) => {
            const status = result.status ?? "done";
            opts.emit({ type: "run.finished", runId, status, detail: "", at: Date.now() });
            resolve({ runId, status, detail: "", messages: [], charsPerToken: 3, ...result });
          },
        });
      }),
  };
});

const { AgentSession } = await import("../../src/main/session.js");

function makeSession() {
  const events: AgentEvent[] = [];
  const session = new AgentSession({
    tools: { list: () => [], get: () => undefined, register: () => {} } as never,
    emit: (e) => events.push(e),
    authorize: async () => ({ decision: "allow" }) as never,
    onUntrustedOutput: () => {},
    grants: new Set<string>(),
  });
  return { session, events };
}

/** Lets the session's own `setTimeout(…, 0)` drain run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("the message queue", () => {
  beforeEach(() => {
    runs.length = 0;
  });

  it("starts at once when the agent is idle, and queues nothing", async () => {
    const { session } = makeSession();
    session.submit("ilk iş", "lmstudio:x");
    await settle();
    expect(runs.map((r) => r.goal)).toEqual(["ilk iş"]);
    expect(session.queued).toEqual([]);
  });

  it("takes the next message on its own when the run ends", async () => {
    const { session } = makeSession();
    session.submit("ilk iş", "lmstudio:x");
    await settle();

    session.submit("ikinci iş", "lmstudio:x");
    session.submit("üçüncü iş", "lmstudio:x");
    expect(session.queued.map((m) => m.text)).toEqual(["ikinci iş", "üçüncü iş"]);
    // Still only one run in flight, whatever the user typed.
    expect(runs).toHaveLength(1);

    runs[0]!.finish({ status: "done" });
    await settle();
    expect(runs.map((r) => r.goal)).toEqual(["ilk iş", "ikinci iş"]);
    expect(session.queued.map((m) => m.text)).toEqual(["üçüncü iş"]);

    runs[1]!.finish({ status: "done" });
    await settle();
    expect(runs.map((r) => r.goal)).toEqual(["ilk iş", "ikinci iş", "üçüncü iş"]);
    expect(session.queued).toEqual([]);
  });

  it("jumps the line when the user interrupts, and stops the run to do it", async () => {
    const { session } = makeSession();
    session.submit("uzun iş", "lmstudio:x");
    await settle();
    session.submit("sonra bunu", "lmstudio:x");

    session.steer("hayır, şunu yap", "lmstudio:x");
    expect(runs[0]!.signal.aborted).toBe(true);
    expect(session.queued.map((m) => m.text)).toEqual(["hayır, şunu yap", "sonra bunu"]);

    runs[0]!.finish({ status: "stopped" });
    await settle();
    expect(runs[1]!.goal).toBe("hayır, şunu yap");
    expect(session.queued.map((m) => m.text)).toEqual(["sonra bunu"]);
  });

  it("lets any waiting message interrupt, the first one too", async () => {
    const { session } = makeSession();
    session.submit("uzun iş", "lmstudio:x");
    await settle();
    const first = session.submit("acil düzeltme", "lmstudio:x");
    session.submit("sonra bunu", "lmstudio:x");

    session.interrupt(first!.id);
    expect(runs[0]!.signal.aborted).toBe(true);
    expect(session.queued.map((m) => m.text)).toEqual(["acil düzeltme", "sonra bunu"]);

    runs[0]!.finish({ status: "stopped" });
    await settle();
    expect(runs[1]!.goal).toBe("acil düzeltme");
    expect(session.queued.map((m) => m.text)).toEqual(["sonra bunu"]);
  });

  it("moves a later message to the front when it interrupts", async () => {
    const { session } = makeSession();
    session.submit("uzun iş", "lmstudio:x");
    await settle();
    session.submit("bir", "lmstudio:x");
    const later = session.submit("iki", "lmstudio:x");

    session.interrupt(later!.id);
    expect(session.queued.map((m) => m.text)).toEqual(["iki", "bir"]);
    runs[0]!.finish({ status: "stopped" });
    await settle();
    expect(runs[1]!.goal).toBe("iki");
  });

  it("ignores an interrupt for a message that is no longer waiting", async () => {
    const { session } = makeSession();
    session.submit("çalışan", "lmstudio:x");
    await settle();
    session.interrupt("q-yok");
    expect(runs[0]!.signal.aborted).toBe(false);
  });

  it("keeps what the agent had done, so the correction lands with context", async () => {
    const { session } = makeSession();
    session.submit("sayfayı aç", "lmstudio:x");
    await settle();

    // Stopped between the model asking for a tool and the tool answering:
    // the shape every provider rejects.
    const interrupted: ChatMessage[] = [
      { role: "user", content: "<user_request>sayfayı aç</user_request>" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "page_goto", argumentsText: "{}" }] },
    ];
    runs[0]!.finish({ status: "stopped", messages: interrupted });
    await settle();

    session.submit("şimdi şunu yap", "lmstudio:x");
    await settle();
    // The next run carries the old turn, with the orphaned call answered.
    const history = runs[1]!.history;
    expect(history.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(history.at(-1)?.content).toMatch(/user interrupted/i);
  });

  it("drops a failed run's transcript instead of building on it", async () => {
    const { session } = makeSession();
    session.submit("bir iş", "lmstudio:x");
    await settle();
    runs[0]!.finish({ status: "failed", messages: [{ role: "user", content: "x" }] });
    await settle();

    session.submit("sonraki", "lmstudio:x");
    await settle();
    expect(runs[1]!.history).toEqual([]);
  });

  it("lets a waiting message be taken back", async () => {
    const { session } = makeSession();
    session.submit("çalışan", "lmstudio:x");
    await settle();
    const queued = session.submit("vazgeçtim", "lmstudio:x");
    session.drop(queued!.id);
    expect(session.queued).toEqual([]);

    runs[0]!.finish({ status: "done" });
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("starts nothing new after an emergency stop", async () => {
    const { session } = makeSession();
    session.submit("çalışan", "lmstudio:x");
    await settle();
    session.submit("sırada bekleyen", "lmstudio:x");

    // What the emergency shortcut does: clear, then cut.
    session.clearQueue();
    session.stop();
    runs[0]!.finish({ status: "stopped" });
    await settle();

    expect(runs).toHaveLength(1);
    expect(session.queued).toEqual([]);
  });

  it("tells whoever is listening whenever the line changes", async () => {
    const { session } = makeSession();
    const seen: string[][] = [];
    session.onQueueChange((queue) => seen.push(queue.map((m) => m.text)));

    session.submit("çalışan", "lmstudio:x");
    await settle();
    session.submit("bir", "lmstudio:x");
    session.submit("iki", "lmstudio:x");
    runs[0]!.finish({ status: "done" });
    await settle();

    expect(seen).toEqual([["bir"], ["bir", "iki"], ["iki"]]);
  });

  it("ignores an empty message rather than starting an empty run", async () => {
    const { session } = makeSession();
    expect(session.submit("   ", "lmstudio:x")).toBeNull();
    session.steer("  ", "lmstudio:x");
    await settle();
    expect(runs).toEqual([]);
  });
});
