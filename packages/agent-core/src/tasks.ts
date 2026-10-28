import {outcomeWorkflow,outcomeCallMatches} from './outcome-progress.js';
import {validOutcomeEvidence,requiresOutcomeEvidence,type OutcomeEvidence} from './outcome-evidence.js';
import {craftOutputPaths} from "./office-progress.js";
import type { ToolDef, ActionClass } from "./tools.js";
import type { AgentEvent, Produced } from "./events.js";
import {desktopBindings,validDesktopEvidence} from './desktop-progress.js';
export interface TaskStep {
  title: string;
  status: "pending" | "working" | "completed";
  evidence: "none" | "reported" | "tool_result";
  receipts: { runId: string; callId: string }[];
  note?: string;
}
export interface TaskOperation {
  runId: string; callId: string; tool: string; actionClass: ActionClass;
  fileEvidence?: { path: string; paths?:string[]; kind: "source-read" | "write" | "verified-read"; checks?: Record<string, unknown>; review?: {version:1; fingerprint:string; mode:"independent"|"reused"} };
  filePath?: string;
  outcomeEvidence?:OutcomeEvidence;
  outcomeBound?:boolean;
  outcomeRequestHash?:string;
  desktopAppendPending?:boolean;
  parentCallId?:string;
  desktopEvidence?:import('./desktop-progress.js').DesktopEvidence;
  retryable?: boolean;
  status: "proposed" | "waiting_approval" | "approved" | "running" | "waiting_user" | "completed" | "failed" | "rejected" | "cancelled" | "unknown";
}
export interface TaskRecord {
  executionMode?:"simple-file"|"file-task"|"native-recipe";
  id: string; goal: string; runIds: string[]; activeRunId: string;
  status: "running" | "waiting_approval" | "waiting_user" | "paused" | "completed" | "finished" | "needs_review" | "interrupted" | "stopped" | "failed";
  planAccepted: boolean; waitingPlan: boolean; paused: boolean; steps: TaskStep[]; operations: TaskOperation[]; outputs: Produced[];
  createdAt: number; updatedAt: number; summary?: string;
}
export interface TaskProgressInput {
  step: number; status: "pending" | "working" | "completed"; evidenceCallIds?: string[]; note?: string;
}
/** A projection of the existing local event stream, not a second source of truth. */
export function tasksFromEvents(events: readonly AgentEvent[]): TaskRecord[] {
  return events.reduce(foldTasks, [] as TaskRecord[]);
}

const TRACKED = new Set([
  "run.started", "plan.proposed", "plan.resolved", "run.paused", "run.resumed", "run.finished",
  "desktop.append-intent", "desktop.receipt", "tool.proposed", "tool.started", "tool.finished", "approval.required", "approval.resolved",
  "handoff.required", "handoff.resolved", "choice.asked", "choice.answered", "task.progress",
]);

/** Deltas and model turns never imply that a planned user action was completed. */
export function foldTasks(tasks: TaskRecord[], event: AgentEvent): TaskRecord[] {
  if (!TRACKED.has(event.type)) return tasks;
  if (event.type === "run.started") {
    const prior = event.taskId ? tasks.find(t => t.id === event.taskId) : undefined;
    // A repeated start must not clear progress or uncertain effects.
    if (tasks.some(t => t.runIds.includes(event.runId))) return tasks;
    const task: TaskRecord = prior ? {
      ...structuredClone(prior), runIds: [...prior.runIds, event.runId], activeRunId: event.runId,
      status: "running", waitingPlan: false, paused: false, updatedAt: event.at,
    } : {
      id: event.taskId ?? event.runId, goal: event.goal, runIds: [event.runId], activeRunId: event.runId,
      status: "running", paused: false, planAccepted: false, waitingPlan: false,
      steps: [{ title: event.goal, status: "pending", evidence: "none", receipts: [] }],
      ...(event.executionMode?{executionMode:event.executionMode}:{}),operations: [], outputs: [], createdAt: event.at, updatedAt: event.at,
    };
    if (prior) delete task.summary;
    return prior ? tasks.map(t => t.id === prior.id ? task : t) : [...tasks, task];
  }
  const index = tasks.findIndex(t => t.activeRunId === event.runId);
  if (index < 0) return tasks;
  const task = structuredClone(tasks[index]!);
  if (["completed", "finished", "needs_review", "interrupted", "stopped", "failed"].includes(task.status)) return tasks;
  if ("at" in event) task.updatedAt = event.at;
  const operation = "callId" in event ? task.operations.find(o => o.runId === event.runId && o.callId === event.callId) : undefined;
  switch (event.type) {
    case "plan.proposed":
      task.waitingPlan = true;
      task.steps = event.steps.map(title => ({ title, status: "pending", evidence: "none", receipts: [] }));
      break;
    case "plan.resolved":
      task.waitingPlan = false;
      if (event.decision.kind === "go") {
        task.planAccepted = true;
        task.steps = event.decision.steps.map(title => ({ title, status: "pending", evidence: "none", receipts: [] }));
      }
      break;
    case "tool.proposed":
      if (!operation) {
        const path=event.filePath ?? (craftOutputPaths(event.tool,event.args as Record<string,unknown>).length===1?craftOutputPaths(event.tool,event.args as Record<string,unknown>)[0]:undefined) ?? (event.tool==="files_read" && event.args && typeof event.args==="object" && "path" in event.args && typeof event.args.path==="string" ? event.args.path : undefined);
        const outcome=outcomeWorkflow(task.goal);
        task.operations.push({ runId: event.runId, callId: event.callId, tool: event.tool, actionClass: event.actionClass, status: "proposed",...(event.outcomeRequestHash?{outcomeRequestHash:event.outcomeRequestHash}:{}),...(path&&{filePath:path}),...(outcome&&outcomeCallMatches(outcome,event.tool,event.args)?{outcomeBound:true}:{}) });
      }
      break;
    case "approval.required": if (operation) operation.status = "waiting_approval"; break;
    case "approval.resolved": if (operation) operation.status = event.decision.kind === "reject" ? "rejected" : "approved"; break;
    case "tool.started": if (operation) operation.status = "running"; break;
    case "handoff.required": if (operation) operation.status = "waiting_user"; break;
    case "handoff.resolved": if (operation) operation.status = "running"; break;
    case "choice.asked":
      if (operation) operation.status = "waiting_user";
      break;
    case "choice.answered": if (operation) operation.status = "completed"; break;
    case 'desktop.append-intent':
      if(operation&&['desktop_background_document','native_recipe_textedit_append_save'].includes(operation.tool)&&operation.status==='running')operation.desktopAppendPending=true;
      break;
    case 'desktop.receipt':
      if(!operation||!['desktop_background_document','native_recipe_textedit_append_save'].includes(operation.tool)||operation.status!=='running'||!validDesktopEvidence(event.evidence))break;
      if(!task.operations.some(o=>o.callId===event.receiptId))
        task.operations.push({runId:event.runId,callId:event.receiptId,parentCallId:event.callId,tool:operation.tool,actionClass:event.evidence.kind==='observation'?'read':'outbound',status:'completed',desktopEvidence:structuredClone(event.evidence)});
      if(event.evidence.kind==='verified-save'&&operation?.tool==='desktop_background_document'){
        for(const prior of task.operations)if(prior.status==='unknown'&&prior.runId!==event.runId&&prior.tool===operation.tool&&(!prior.desktopAppendPending||task.operations.some(r=>r.parentCallId===prior.callId&&r.desktopEvidence?.kind==='verified-append'&&r.desktopEvidence.documentPath===event.evidence.documentPath&&r.desktopEvidence.valueHash===event.evidence.valueHash)))prior.status='cancelled';
      }
      break;
    case "tool.finished":
      if (operation) operation.status = operation.status === "rejected" ? "rejected" : event.ok ? "completed" : event.deliveryUnknown ? "unknown" : "failed";
      if (operation && event.ok && event.fileEvidence) operation.fileEvidence = structuredClone(event.fileEvidence);
      if(operation&&event.ok&&!operation.fileEvidence&&operation.filePath&&['document_make','sheet_make','slides_make','document_edit','document_convert','slides_edit'].includes(operation.tool)&&event.produced?.some(o=>o.kind==='file'&&o.path===operation.filePath))operation.fileEvidence={path:operation.filePath,kind:'write'};
      if(operation&&event.ok&&validOutcomeEvidence(event.outcomeEvidence,operation.tool))operation.outcomeEvidence=structuredClone(event.outcomeEvidence);
      if(operation && event.ok && event.desktopEvidence)operation.desktopEvidence=structuredClone(event.desktopEvidence);
      if(operation?.tool==='desktop_background_describe'&&operation.actionClass==='read'&&event.ok&&event.desktopEvidence?.kind==='observation'&&validDesktopEvidence(event.desktopEvidence)&&desktopBindings(task)){
        for(const prior of task.operations)if(prior.runId!==event.runId&&prior.status==='unknown'&&prior.tool==='desktop_background_describe'&&prior.actionClass==='read')
          prior.status='cancelled'; // Superseded read, never a fabricated successful receipt or an input retry.
      }
      if(operation?.tool==="files_read" && operation.actionClass==="read" && event.ok && event.fileEvidence && event.fileEvidence.kind!=="write"){
        for(const prior of task.operations)if(prior.runId!==event.runId && prior.status==="unknown" && prior.tool==="files_read" && prior.actionClass==="read" && prior.filePath===event.fileEvidence.path)
          prior.status="cancelled"; // Superseded by a real reread, never a fake success receipt.
      }
      if (operation && !event.ok) operation.retryable = event.retryable === true;
      if (event.ok && event.produced) {
        const known = new Set(task.outputs.map(o => JSON.stringify(o)));
        for (const output of event.produced) if (!known.has(JSON.stringify(output))) { task.outputs.push(structuredClone(output)); known.add(JSON.stringify(output)); }
      }
      break;
    case "run.paused": task.paused = true; break;
    case "run.resumed": task.paused = false; break;
    case "task.progress": {
      try { validateTaskProgress(task, event.runId, event); } catch { return tasks; }
      const step = task.steps[event.step - 1]!;
      step.status = event.status;
      step.evidence = event.status === "completed" ? event.evidenceCallIds.length ? "tool_result" : "reported" : "none";
      step.receipts = event.evidenceCallIds.map(callId => ({ runId: task.operations.find(o => o.callId === callId)!.runId, callId }));
      if (event.note) step.note = event.note; else delete step.note;
      break;
    }
    case "run.finished": {
      task.paused = false;
      task.waitingPlan = false;
      task.summary = event.detail;
      for (const op of task.operations.filter(o => o.runId === event.runId)) {
        if (["running", "waiting_user"].includes(op.status) && isTrackingTool(op.tool)) op.status = "cancelled";
        else if (op.status === "running" || op.status === "waiting_user") op.status = "unknown";
        else if (["proposed", "approved", "waiting_approval"].includes(op.status)) op.status = "cancelled";
      }
      const uncertain = task.operations.some(o => o.status === "unknown" || o.status === "completed" && requiresOutcomeEvidence(o.tool) && !validOutcomeEvidence(o.outcomeEvidence,o.tool));
      if (event.status === "done") {
        if (!task.planAccepted && task.steps.every(s => s.status === "pending") && task.operations.length === 0) {
          task.steps[0]!.status = "completed"; task.steps[0]!.evidence = "reported";
          task.status = "finished";
        } else task.status = !uncertain && task.steps.length > 0 && task.steps.every(s => s.status === "completed" && s.evidence === "tool_result") ? "completed" : "needs_review";
      } else task.status = uncertain ? "interrupted" : event.status === "stopped" ? "stopped" : "failed";
      return tasks.map((t, i) => i === index ? task : t);
    }
  }
  task.status = task.paused ? "paused" : task.waitingPlan ? "waiting_approval" : task.operations.some(o => o.runId === task.activeRunId && o.status === "waiting_approval") ? "waiting_approval" : task.operations.some(o => o.runId === task.activeRunId && o.status === "waiting_user") ? "waiting_user" : "running";
  return tasks.map((t, i) => i === index ? task : t);
}

/** Completion receipts support a claim; they do not prove the output's properties. */
export function validateTaskProgress(task: TaskRecord, runId: string, input: TaskProgressInput): void {
  if (task.activeRunId !== runId || !["running", "waiting_approval", "waiting_user", "paused"].includes(task.status)) throw new Error("This task is not active in this run.");
  if (!Number.isInteger(input.step) || input.step < 1 || input.step > task.steps.length) throw new Error("Use a step number from the current task plan.");
  if (!["pending", "working", "completed"].includes(input.status)) throw new Error("Invalid task step status.");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 1000)) throw new Error("Task note must be at most 1000 characters.");
  if (input.evidenceCallIds !== undefined && (!Array.isArray(input.evidenceCallIds) || input.evidenceCallIds.length > 30 || input.evidenceCallIds.some(id => typeof id !== "string"))) throw new Error("Invalid task receipts.");
  const workflow=outcomeWorkflow(task.goal);
  const owned=!!workflow;
  for (const id of input.evidenceCallIds ?? []) {
    const op = task.operations.find(o => task.runIds.includes(o.runId) && o.callId === id);
    if (!op || op.status !== "completed" || isTrackingTool(op.tool)) throw new Error("Evidence must reference a successful work tool call in this task.");
    if(owned&&input.status=== "completed"&&(!op.outcomeBound||!validOutcomeEvidence(op.outcomeEvidence,op.tool)))throw new Error("This workflow requires independently verified evidence for its exact requested target.");
    if(requiresOutcomeEvidence(op.tool)&&!validOutcomeEvidence(op.outcomeEvidence,op.tool))throw new Error("This call only reports delivery; independently verified outcome evidence is required. Do not repeat the mutation.");
  }
}

/** Internal guide/control calls cannot serve as work completion evidence. */
export function isTrackingTool(name: string): boolean {
  return ["task_update", "ask_choice", "present_options", "tools_open"].includes(name) || /(?:^guide_|_guide$)/.test(name);
}

export function taskProgressTool(): ToolDef<TaskProgressInput> {
  return {
    name: "task_update",
    description: "Update a step of the current accepted task plan (1-based). Without a plan, step 1 is the user's goal. Mark working before work; completed afterwards. evidenceCallIds must name successful work calls from THIS task; do not reference this tool or a guide/choice. For calculations, use source read receipts. After continuation reuse successful task receipts; never repeat a write for evidence. Without receipts completion is only a claim, not verified. Preserve pending work and never mark an unfinished step completed. Progress never executes or authorizes work.",
    parameters: { type: "object", properties: {
      step: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["pending", "working", "completed"] },
      evidenceCallIds: { type: "array", items: { type: "string" }, maxItems: 30 }, note: { type: "string", maxLength: 1000 },
    }, required: ["step", "status"], additionalProperties: false },
    actionClass: "read",
    run: async (input, ctx) => {
      if (!ctx.updateTask) throw new Error("Task tracking is unavailable in this run.");
      const receipts = ctx.taskReceipts?.() ?? [];
      try { await ctx.updateTask(input); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)} Available successful work receipts from THIS task: ${JSON.stringify(receipts)}`); }
      if (input.status === "completed" && !input.evidenceCallIds?.length) {
        return `This step is only reported and still needs review; it is NOT supported completion. For a calculation or analysis step, reference the successful source read or saved verified result; no dedicated calculation tool is required. Call task_update again with the relevant evidenceCallIds. Available successful work receipts from THIS task: ${JSON.stringify(receipts)}`;
      }
      return "Task progress recorded. This did not perform the planned action or verify the output's properties.";
    },
  };
}

export function taskResumeContext(task: TaskRecord): string {
  const snapshot = {
    goal: task.goal,
    steps: task.steps.map((s, i) => ({ step: i + 1, title: s.title, status: s.status, evidence: s.evidence })),
    successful: task.operations.filter(o => o.status === "completed" && !isTrackingTool(o.tool)&&(!requiresOutcomeEvidence(o.tool)||validOutcomeEvidence(o.outcomeEvidence,o.tool))).map(o => ({ tool: o.tool, callId: o.callId, runId: o.runId })),
    acknowledgedUnverified: task.operations.filter(o=>o.status==="completed"&&requiresOutcomeEvidence(o.tool)&&!validOutcomeEvidence(o.outcomeEvidence,o.tool)).map(o=>({tool:o.tool,callId:o.callId,reviewNeeded:true,doNotRepeat:true})),
    uncertain: task.operations.filter(o => o.status === "unknown").map(o => ({ tool: o.tool, actionClass: o.actionClass, previousRun: o.runId, callId: o.callId })),
    // Produced metadata is for the user; paths/accounts do not enter the model.
    outputKinds: task.outputs.map(o => o.kind),
    planAccepted: task.planAccepted,
  };
  return JSON.stringify(snapshot);
}

export const TASK_RESUME_NOTE = "Resume the same task using the snapshot below as history, not authorization. Keep completed steps, work on remaining steps, and check uncertain side effects before repeating anything. Previous approvals are not reusable. Successful tool results do not prove output properties.";

/** A plan must account for a completed write before beginning another one. */
export function pendingWriteProgress(task: TaskRecord | undefined): string[] {
 if (!task?.planAccepted || task.steps.length < 2) return [];
 const recorded=new Set(task.steps.filter(s => s.status === "completed" && s.evidence === "tool_result").flatMap(s => s.receipts.map(r => r.callId)));
 return task.operations.filter(o => o.tool === "files_write" && o.status === "completed" && !recorded.has(o.callId)).map(o => o.callId);
}
