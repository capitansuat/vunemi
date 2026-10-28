import { describe, expect, it } from "vitest";
import { tasksFromEvents, type AgentEvent } from "@vunemi/agent-core";
import { createEventBatcher } from "../../src/renderer/src/lib/event-batcher.js";
import { outputArtefact, taskSummary, nearBottom } from "../../src/renderer/src/lib/task-summary.js";
const start: AgentEvent = { type: "run.started", runId: "r", goal: "Read and report", model: "local", at: 1 };
const plan: AgentEvent[] = [start, { type: "plan.proposed", runId: "r", steps: ["Read", "Report"], at: 2 }, { type: "plan.resolved", runId: "r", decision: { kind: "go", steps: ["Read", "Report"] } }];

describe("chat task summary", () => {
  it("keeps reported completion in the remaining work until supported", () => {
    const task = tasksFromEvents([...plan, { type: "task.progress", runId: "r", step: 1, status: "completed", evidenceCallIds: [], at: 3 }])[0]!;
    const summary = taskSummary(task);
    expect(summary.remaining.map(s => s.title)).toEqual(["Read", "Report"]);
    expect(summary.completed).toBe(0); expect(summary.show).toBe(true);
  });
  it("does not add a task card to ordinary conversation or duplicate a waiting plan", () => {
    expect(taskSummary(tasksFromEvents([start])[0]!).show).toBe(false);
    expect(taskSummary(tasksFromEvents(plan.slice(0, 2))[0]!).show).toBe(false);
  });
  it("counts successful steps and preserves uncertainty in the visible summary", () => {
    const task = tasksFromEvents([...plan,
      { type: "tool.proposed", runId: "r", stepId: "s", callId: "c", tool: "file_read", actionClass: "read", args: {} },
      { type: "tool.finished", runId: "r", callId: "c", ok: true, output: "read", durationMs: 1 },
      { type: "task.progress", runId: "r", step: 1, status: "completed", evidenceCallIds: ["c"], at: 3 },
      { type: "tool.proposed", runId: "r", stepId: "s", callId: "w", tool: "file_write", actionClass: "write-local", args: {} },
      { type: "tool.started", runId: "r", callId: "w", at: 4 },
      { type: "run.finished", runId: "r", status: "stopped", detail: "Closed", at: 5 },
    ])[0]!;
    const summary = taskSummary(task);
    expect(summary.completed).toBe(1); expect(summary.remaining.map(s => s.title)).toEqual(["Report"]);
    expect(summary.uncertain).toBe(1);
  });
  it("follows only when the reader is near the bottom", () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 })).toBe(false);
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 470, clientHeight: 500 })).toBe(true);
  });
});

describe("stream presentation batching", () => {
  function fixture() {
    const delivered: AgentEvent[] = []; let frame: (() => void) | undefined;
    const batch = createEventBatcher(e => delivered.push(e), callback => { frame = callback; return () => { frame = undefined; }; });
    return { batch, delivered, frame: () => { const callback = frame; frame = undefined; callback?.(); } };
  }
  it("combines a token burst into one presentation update without dropping text", () => {
    const f = fixture();
    for (const text of ["Mer", "ha", "ba"]) f.batch.push({ type: "message.delta", runId: "r", stepId: "s", text });
    expect(f.delivered).toEqual([]); f.frame();
    expect(f.delivered).toEqual([{ type: "message.delta", runId: "r", stepId: "s", text: "Merhaba" }]);
  });
  it("flushes text before an approval and delivers the control immediately", () => {
    const f = fixture();
    const control: AgentEvent = { type: "approval.required", runId: "r", stepId: "s", callId: "c", tool: "write", args: {}, actionClass: "write-local", reason: "Approve" };
    f.batch.push({ type: "message.delta", runId: "r", stepId: "s", text: "Ready" }); f.batch.push(control);
    expect(f.delivered.map(e => e.type)).toEqual(["message.delta", "approval.required"]);
    f.frame(); expect(f.delivered).toHaveLength(2);
  });
  it("does not mix thoughts, steps or runs, and flushes on finish", () => {
    const f = fixture();
    f.batch.push({ type: "thought.delta", runId: "r", stepId: "s", text: "thinking" });
    f.batch.push({ type: "message.delta", runId: "r", stepId: "s", text: "A" });
    f.batch.push({ type: "message.delta", runId: "other", stepId: "s", text: "B" });
    f.batch.push({ type: "run.finished", runId: "r", status: "done", detail: "A", at: 3 });
    expect(f.delivered.map(e => "text" in e ? e.text : e.type)).toEqual(["thinking", "A", "B", "run.finished"]);
  });
  it("cancels a queued callback and preserves final text on disposal", () => {
    const f = fixture(); f.batch.push({ type: "message.delta", runId: "r", stepId: "s", text: "final" });
    f.batch.dispose(); f.frame();
    expect(f.delivered).toHaveLength(1);
    f.batch.push(start); expect(f.delivered).toHaveLength(1);
  });
});

it("matches output metadata by value and preserves main's opening capabilities", () => {
  const row = { id: "c:0", at: 1, goal: "Report", item: { path: "/tmp/report.command", kind: "file" as const }, missing: false, canOpen: false, canReveal: true, canPreview: false, canUndo: false };
  expect(outputArtefact({ kind: "file", path: "/tmp/report.command" }, [row])).toBe(row);
  expect(outputArtefact({ kind: "file", path: "/tmp/other.command" }, [row])).toBeUndefined();
});
