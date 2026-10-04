import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@vunemi/agent-core";
import {
  foldEvent,
  pendingApprovals,
  pendingHandoff,
  runStats,
  type CallView,
  type RunView,
} from "../../src/renderer/src/lib/fold.js";

const fold = (events: AgentEvent[]): RunView[] => events.reduce(foldEvent, [] as RunView[]);

const start: AgentEvent[] = [
  { type: "run.started", runId: "r", goal: "g", model: "m", at: 0 },
  { type: "step.started", runId: "r", stepId: "s0", index: 0, at: 1 },
];

describe("foldEvent", () => {
  it("shows compaction under the run it follows, and drops it when nothing changed", () => {
    const base: AgentEvent[] = [...start, { type: "run.finished", runId: "r", status: "done", detail: "ok", at: 2 }];
    expect(fold([...base, { type: "context.compacting", runId: "r", at: 3 }])[0]!.compaction).toEqual({ status: "running" });
    const done = fold([
      ...base,
      { type: "context.compacting", runId: "r", at: 3 },
      { type: "context.compacted", runId: "r", kind: "summarized", before: 24_000, after: 9_000, window: 32_768, summary: "## User's goals", at: 4 },
    ])[0]!;
    expect(done.compaction).toEqual({ status: "done", kind: "summarized", before: 24_000, after: 9_000, summary: "## User's goals" });
    const unchanged = fold([
      ...base,
      { type: "context.compacting", runId: "r", at: 3 },
      { type: "context.compacted", runId: "r", kind: "unchanged", before: 1, after: 1, window: 32_768, at: 4 },
    ])[0]!;
    expect(unchanged.compaction).toBeUndefined();
  });

  it("shows the notes a run was given and what it proposes, as the user answers", () => {
    const run = fold([
      ...start,
      { type: "memory.given", runId: "r", notes: [{ id: "n1", text: "Reply briefly", kind: "general" }], at: 1 },
      { type: "run.finished", runId: "r", status: "done", detail: "ok", at: 2 },
      {
        type: "memory.proposed", runId: "r", at: 3, proposals: [
          { id: "p1", text: "Wants PDF", kind: "general", quote: "as PDF please" },
          { id: "p2", text: "Manager is Deniz", kind: "topic", quote: "my manager is Deniz", updates: { id: "n2", text: "Manager is Ayşe" } },
        ],
      },
      { type: "memory.resolved", runId: "r", proposalId: "p1", decision: "saved", text: "Wants reports as PDF", at: 4 },
      { type: "memory.resolved", runId: "r", proposalId: "p2", decision: "skipped", at: 5 },
    ])[0]!;
    expect(run.memory!.given).toEqual([{ id: "n1", text: "Reply briefly", kind: "general" }]);
    expect(run.memory!.proposals.map((p) => [p.text, p.state])).toEqual([["Wants reports as PDF", "saved"], ["Manager is Deniz", "skipped"]]);
  });

  it("builds a step with streamed thought and text", () => {
    const [run] = fold([
      ...start,
      { type: "thought.delta", runId: "r", stepId: "s0", text: "hm" },
      { type: "thought.delta", runId: "r", stepId: "s0", text: "m" },
      { type: "message.delta", runId: "r", stepId: "s0", text: "Hi" },
    ]);
    expect(run!.steps[0]).toMatchObject({ thought: "hmm", text: "Hi" });
    expect(run!.status).toBe("running");
  });

  it("walks a call through approval, run, and result", () => {
    const events: AgentEvent[] = [
      ...start,
      { type: "tool.proposed", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "write-local" },
      { type: "approval.required", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "write-local", reason: "why" },
    ];
    expect(fold(events)[0]!.steps[0]!.calls[0]!.status).toBe("awaiting");

    events.push(
      { type: "approval.resolved", runId: "r", callId: "c", decision: { kind: "approve" } },
      { type: "tool.started", runId: "r", callId: "c", at: 2 },
    );
    expect(fold(events)[0]!.steps[0]!.calls[0]!.status).toBe("running");

    events.push({ type: "tool.finished", runId: "r", callId: "c", ok: true, output: "done", durationMs: 5 });
    expect(fold(events)[0]!.steps[0]!.calls[0]).toMatchObject({ status: "ok", output: "done", durationMs: 5 });
  });

  it("lists the files a call wrote under the ids the Artefacts store uses", () => {
    const [run] = fold([
      ...start,
      { type: "tool.proposed", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "write-local" },
      {
        type: "tool.finished", runId: "r", callId: "c", ok: true, output: "ok", durationMs: 1,
        produced: [{ kind: "event", title: "x", start: "2026-09-25" }, { kind: "file", path: "/Users/me/Desktop/report.pdf" }],
      },
    ]);
    expect(run!.steps[0]!.calls[0]!.files).toEqual([{ id: "c:1", name: "report.pdf" }]);
  });

  it("keeps a rejected call rejected when the refusal comes back as tool.finished", () => {
    const [run] = fold([
      ...start,
      { type: "tool.proposed", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "outbound" },
      { type: "approval.resolved", runId: "r", callId: "c", decision: { kind: "reject" } },
      { type: "tool.finished", runId: "r", callId: "c", ok: false, output: "declined", durationMs: 0 },
    ]);
    expect(run!.steps[0]!.calls[0]!.status).toBe("rejected");
  });

  it("closes out calls left waiting when the run is stopped", () => {
    const [run] = fold([
      ...start,
      { type: "tool.proposed", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "write-local" },
      { type: "approval.required", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "write-local", reason: "" },
      { type: "run.finished", runId: "r", status: "stopped", detail: "Stopped by user.", at: 9 },
    ]);
    expect(run!.status).toBe("stopped");
    expect(run!.steps[0]!.calls[0]!.status).toBe("rejected");
  });

  it("only touches the run an event belongs to", () => {
    const runs = fold([
      { type: "run.started", runId: "a", goal: "1", model: "m", at: 0 },
      { type: "run.finished", runId: "a", status: "done", detail: "ok", at: 1 },
      { type: "run.started", runId: "b", goal: "2", model: "m", at: 2 },
      { type: "step.started", runId: "b", stepId: "b0", index: 0, at: 3 },
    ]);
    expect(runs.map((r) => [r.runId, r.status, r.steps.length])).toEqual([
      ["a", "done", 0],
      ["b", "running", 1],
    ]);
  });
  it("lists the notes a run saved, once per note", () => {
    const at = 0;
    const runs = [
      { type: "run.started", runId: "r1", goal: "g", model: "m", at },
      { type: "note.saved", runId: "r1", noteId: "n1", title: "Logo decision", scope: "project", at },
      { type: "note.saved", runId: "r1", noteId: "n1", title: "Logo decision v2", scope: "project", at },
      { type: "note.saved", runId: "r1", noteId: "n2", title: "Mine", scope: "conversation", at },
    ].reduce(foldEvent as never, []) as RunView[];
    expect(runs[0]!.notes).toEqual([
      { id: "n1", title: "Logo decision v2", scope: "project" },
      { id: "n2", title: "Mine", scope: "conversation" },
    ]);
  });

});

describe("tool output", () => {
  it("shows the user all of it when the model was given a shorter copy", () => {
    const [run] = fold([
      ...start,
      { type: "tool.proposed", runId: "r", stepId: "s0", callId: "c", tool: "t", args: {}, actionClass: "read" },
      { type: "tool.finished", runId: "r", callId: "c", ok: true, output: "short", display: "short and links", durationMs: 1 },
    ]);
    expect(run!.steps[0]!.calls[0]!.output).toBe("short and links");
  });
});

describe("runStats", () => {
  it("averages throughput and reports first-token latency", () => {
    const [run] = fold([
      ...start,
      { type: "usage", runId: "r", stepId: "s0", promptTokens: 500, completionTokens: 10, ttftMs: 800, tokensPerSec: 40 },
      { type: "step.started", runId: "r", stepId: "s1", index: 1, at: 2 },
      { type: "usage", runId: "r", stepId: "s1", promptTokens: 620, completionTokens: 10, ttftMs: 700, tokensPerSec: 50 },
    ]);
    expect(runStats(run!)).toEqual({ steps: 2, tools: 0, tokensPerSec: 45, ttftMs: 800, lastPromptTokens: 620, lastParts: null });
  });

  it("keeps what the last request was made of, by kind", () => {
    const [run] = fold([
      ...start,
      { type: "usage", runId: "r", stepId: "s0", promptTokens: 900, completionTokens: 10, ttftMs: 800, tokensPerSec: 40,
        ledger: [{ kind: "tools", name: "mail", tokens: 400 }, { kind: "tools", name: "browser", tokens: 300 }, { kind: "system", name: "core", tokens: 200 }] },
    ]);
    expect(runStats(run!).lastParts).toEqual({ tools: 700, system: 200 });
  });
});

describe("intent preview", () => {
  const proposed: AgentEvent = { type: "plan.proposed", runId: "r", steps: ["Aç", "Oku"], at: 2 };

  it("shows the plan, then the steps the user agreed to", () => {
    const [run] = fold([
      { type: "run.started", runId: "r", goal: "g", model: "m", at: 0 },
      proposed,
      { type: "plan.resolved", runId: "r", decision: { kind: "go", steps: ["Sadece oku"] } },
    ]);
    expect(run!.plan).toEqual({ steps: ["Sadece oku"], status: "accepted" });
  });

  it("keeps the proposed steps when the user cancels", () => {
    const [run] = fold([
      { type: "run.started", runId: "r", goal: "g", model: "m", at: 0 },
      proposed,
      { type: "plan.resolved", runId: "r", decision: { kind: "cancel" } },
    ]);
    expect(run!.plan).toEqual({ steps: ["Aç", "Oku"], status: "cancelled" });
  });

  it("never leaves a plan waiting once the run is over", () => {
    const [run] = fold([
      { type: "run.started", runId: "r", goal: "g", model: "m", at: 0 },
      proposed,
      { type: "run.finished", runId: "r", status: "stopped", detail: "", at: 9 },
    ]);
    expect(run!.plan!.status).toBe("cancelled");
  });
});

describe("what is waiting for the user", () => {
  const run = (calls: Partial<CallView>[]): RunView => ({
    runId: "r1",
    goal: "g",
    model: "m",
    status: "running",
    startedAt: 0,
    steps: [
      {
        stepId: "s1",
        index: 0,
        startedAt: 0,
        thought: "",
        text: "",
        calls: calls.map((c, i) => ({
          callId: `c${i}`,
          tool: "page_click",
          args: {},
          actionClass: "outbound",
          status: "running",
          ...c,
        })) as CallView[],
      },
    ],
  });

  it("finds the handoff the run is stopped at", () => {
    const runs = [run([{ status: "ok" }, { callId: "c9", handoff: "Robot doğrulamasını tamamla" }])];
    expect(pendingHandoff(runs)).toEqual({ callId: "c9", reason: "Robot doğrulamasını tamamla" });
  });

  it("says nothing is waiting once the handoff is resolved", () => {
    expect(pendingHandoff([run([{ status: "ok" }])])).toBe(null);
    expect(pendingApprovals([run([{ status: "ok" }])])).toBe(0);
  });

  it("counts approval cards, but not the handoff card", () => {
    const runs = [run([{ status: "awaiting" }, { status: "awaiting" }, { status: "awaiting", handoff: "sıra sende" }])];
    expect(pendingApprovals(runs)).toBe(2);
  });
});

describe("a shorter context", () => {
  it("is kept with the run it was told to", () => {
    let runs = foldEvent([], { type: "run.started", runId: "r", goal: "g", model: "m", at: 0 });
    runs = foldEvent(runs, { type: "model.context", runId: "r", context: 16_384, wanted: 32_768, tight: false, at: 1 });
    expect(runs[0]!.lowered).toEqual({ context: 16_384, wanted: 32_768, tight: false });
  });
});
