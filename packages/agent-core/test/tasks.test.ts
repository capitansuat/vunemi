import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { taskResumeContext, tasksFromEvents, validateTaskProgress } from "../src/tasks.js";
const start: AgentEvent = { type: "run.started", runId: "r1", goal: "Read data and make a report", model: "local", at: 1 };
const plan: AgentEvent[] = [start, { type: "plan.proposed", runId: "r1", steps: ["Read data", "Make report"], at: 2 }, { type: "plan.resolved", runId: "r1", decision: { kind: "go", steps: ["Read data", "Make report"] } }];
const proposed: AgentEvent = { type: "tool.proposed", runId: "r1", stepId: "model1", callId: "c1", tool: "file_read", args: {}, actionClass: "read" };
const success: AgentEvent = { type: "tool.finished", runId: "r1", callId: "c1", ok: true, output: "read", produced: [{ kind: "file", path: "/tmp/report.docx" }], durationMs: 1 };

describe("persistent task projection", () => {
  it("keeps the user goal and accepted plan distinct from model turns", () => {
    const task = tasksFromEvents([...plan, { type: "step.started", runId: "r1", stepId: "model1", index: 0, at: 3 }])[0];
    expect(task).toMatchObject({ id: "r1", goal: start.goal, status: "running", planAccepted: true });
    expect(task?.steps.map(s => [s.title, s.status])).toEqual([["Read data", "pending"], ["Make report", "pending"]]);
  });
  it("shows approval and user handoff waiting, preserving pause until resume", () => {
    const events: AgentEvent[] = [...plan, proposed, { type: "approval.required", runId: "r1", stepId: "model1", callId: "c1", tool: "file_read", args: {}, actionClass: "read", reason: "approve" }];
    expect(tasksFromEvents(events)[0]?.status).toBe("waiting_approval");
    events.push({ type: "run.paused", runId: "r1", at: 4 }, { type: "approval.resolved", runId: "r1", callId: "c1", decision: { kind: "approve" } });
    expect(tasksFromEvents(events)[0]?.status).toBe("paused");
    events.push({ type: "run.resumed", runId: "r1", at: 5 }, { type: "tool.started", runId: "r1", callId: "c1", at: 6 }, { type: "handoff.required", runId: "r1", callId: "c1", reason: "Sign in", at: 7 });
    expect(tasksFromEvents(events)[0]?.status).toBe("waiting_user");
  });
  it("records completed operations and produced items without silently completing plan steps", () => {
    const task = tasksFromEvents([...plan, proposed, success])[0];
    expect(task?.operations[0]).toMatchObject({ runId: "r1", callId: "c1", status: "completed" });
    expect(task?.outputs).toEqual([{ kind: "file", path: "/tmp/report.docx" }]);
    expect(task?.steps.map(s => s.status)).toEqual(["pending", "pending"]);
  });
  it("separates a model completion claim from a successful tool receipt", () => {
    const task = tasksFromEvents([...plan, proposed, success, { type: "task.progress", runId: "r1", step: 1, status: "completed", evidenceCallIds: ["c1"], at: 4 }, { type: "task.progress", runId: "r1", step: 2, status: "completed", evidenceCallIds: [], at: 5 }, { type: "run.finished", runId: "r1", status: "done", detail: "Done", at: 6 }])[0];
    expect(task?.steps.map(s => s.evidence)).toEqual(["tool_result", "reported"]);
    expect(task?.status).toBe("needs_review");
  });
  it("keeps an interrupted started operation unknown and resumes the same task", () => {
    const events: AgentEvent[] = [...plan, proposed, { type: "tool.started", runId: "r1", callId: "c1", at: 3 }, { type: "run.finished", runId: "r1", status: "stopped", detail: "Closed", at: 4 }];
    const cut = tasksFromEvents(events)[0];
    expect(cut?.operations[0]?.status).toBe("unknown"); expect(cut?.status).toBe("interrupted");
    events.push({ type: "run.started", runId: "r2", taskId: "r1", goal: "Continue", model: "local", at: 5 });
    const resumed = tasksFromEvents(events);
    expect(resumed).toHaveLength(1); expect(resumed[0]?.goal).toBe(start.goal);
    expect(resumed[0]?.runIds).toEqual(["r1", "r2"]);
    expect(resumed[0]?.operations[0]?.status).toBe("unknown");
  });
  it("rejects failed, unknown, or earlier-run receipts as progress evidence", () => {
    const task = tasksFromEvents([...plan, proposed, { ...success, ok: false }])[0]!;
    expect(() => validateTaskProgress(task, "r1", { step: 1, status: "completed", evidenceCallIds: ["c1"] })).toThrow();
    expect(() => validateTaskProgress(task, "r1", { step: 3, status: "working" })).toThrow();
    expect(() => validateTaskProgress(task, "r2", { step: 1, status: "completed", evidenceCallIds: ["c1"] })).toThrow();
  });
  it("does not count pending approval as an uncertain executed operation", () => {
    const task = tasksFromEvents([...plan, proposed, { type: "run.finished", runId: "r1", status: "stopped", detail: "Stopped", at: 4 }])[0];
    expect(task?.status).toBe("stopped"); expect(task?.operations[0]?.status).toBe("cancelled");
  });
  it("tracks plan approval waiting separately from execution", () => {
    expect(tasksFromEvents(plan.slice(0, 2))[0]?.status).toBe("waiting_approval");
  });
  it("does not treat an unanswered choice as an executed side effect", () => {
    const task = tasksFromEvents([start, { ...proposed, tool: "ask_choice" }, { type: "choice.asked", runId: "r1", stepId: "model1", callId: "c1", card: { kind: "choice", question: "Which?", options: ["A", "B"], allowOther: false }, at: 2 }, { type: "run.finished", runId: "r1", status: "stopped", detail: "Stopped", at: 3 }])[0];
    expect(task?.status).toBe("stopped"); expect(task?.operations[0]?.status).toBe("cancelled");
  });

});

it("withholds produced file and account metadata from model recovery context", () => {
  const task = tasksFromEvents([start, proposed, success])[0]!;
  const context = taskResumeContext(task);
  expect(context).toContain('"outputKinds":["file"]');
  expect(context).not.toContain("/tmp/report.docx");
});

it("keeps projected output metadata independent of the canonical events", () => {
  const event: AgentEvent = { ...success, produced: [{ kind: "file", path: "/tmp/original.docx" }] };
  const task = tasksFromEvents([start, proposed, event])[0]!;
  const output = task.outputs[0]!;
  if (output.kind === "file") output.path = "/tmp/changed.docx";
  expect(event.produced).toEqual([{ kind: "file", path: "/tmp/original.docx" }]);
});

it.each(['files_read','files_write'])('reconciles only an uncertain read after a successful reread (%s)',tool=>{
 const events:AgentEvent[]=[start,{...proposed,tool,args:{path:'/tmp/a.md'},actionClass:tool==='files_read'?'read':'write-local'},
  {type:'tool.started',runId:'r1',callId:'c1',at:2},{type:'run.finished',runId:'r1',status:'stopped',detail:'',at:3},
  {type:'run.started',runId:'r2',taskId:'r1',goal:'Continue',model:'local',at:4},
  {type:'tool.proposed',runId:'r2',stepId:'s2',callId:'c2',tool:'files_read',args:{path:'/tmp/a.md'},actionClass:'read'},
  {type:'tool.finished',runId:'r2',callId:'c2',ok:true,output:'checked',fileEvidence:{path:'/tmp/a.md',kind:'verified-read'},durationMs:1}];
 const task=tasksFromEvents(events)[0]!;
 expect(task.operations[0]!.status).toBe(tool==='files_read'?'cancelled':'unknown');
 expect(task.operations[1]!.status).toBe('completed');
});
it.each([false,true])('keeps an uncertain read unresolved after a failed or unrelated reread (ok=%s)',ok=>{
 const events:AgentEvent[]=[start,{...proposed,tool:'files_read',args:{path:'/tmp/a.md'}},
  {type:'tool.started',runId:'r1',callId:'c1',at:2},{type:'run.finished',runId:'r1',status:'stopped',detail:'',at:3},
  {type:'run.started',runId:'r2',taskId:'r1',goal:'Continue',model:'local',at:4},
  {type:'tool.proposed',runId:'r2',stepId:'s2',callId:'c2',tool:'files_read',args:{path:ok?'/tmp/b.md':'/tmp/a.md'},actionClass:'read'},
  {type:'tool.finished',runId:'r2',callId:'c2',ok,output:'read',fileEvidence:{path:ok?'/tmp/b.md':'/tmp/a.md',kind:'verified-read'},durationMs:1}];
 expect(tasksFromEvents(events)[0]!.operations[0]!.status).toBe('unknown');
});
