/**
 * Folds the agent's event stream into what the UI draws. Pure: same events in,
 * same view out, so the timeline can be rebuilt from a recorded log.
 */

import { ledgerTotals, type ActionClass, type AgentEvent, type ApprovalDecision, type Artifact, type ChoiceCard, type LedgerKind, type MemoryNote, type MemoryProposal, type Produced, type RunStatus } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";

export type CallStatus = "proposed" | "awaiting" | "running" | "ok" | "error" | "rejected";

export interface CallView {
  callId: string;
  tool: string;
  args: unknown;
  actionClass: ActionClass;
  status: CallStatus;
  /** What exactly the call targets, e.g. `button "Search"`. */
  preview?: string;
  output?: string;
  durationMs?: number;
  reason?: string;
  /** The reason is a warning to read, not routine policy. */
  alert?: boolean;
  /** Text in what the call read that was written as instructions to the assistant. */
  flagged?: string;
  /** "Always allow" does not apply to this call. */
  alwaysAsk?: boolean;
  /** The tool is switched off; this is its connection and part, and the card offers to switch it on. */
  switchedOff?: string;
  /** Set while the call waits for the user to do something themselves (a CAPTCHA, a login). */
  handoff?: string;
  /** Something the call produced for the user to look at, e.g. a screenshot. */
  artifact?: Artifact;
  /** Pictures for the person, shown as tiles (found photos, say). */
  gallery?: Artifact[];
  /** Files the call wrote, by their id in the Artefacts list, so the card can open them. */
  files?: { id: string; name: string }[];
}

export interface UsageView {
  promptTokens: number | null;
  completionTokens: number | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  /** Tokens per kind of part in the request; absent from older runs. */
  parts?: Partial<Record<LedgerKind, number>>;
}

export interface StepView {
  stepId: string;
  index: number;
  startedAt: number;
  thought: string;
  text: string;
  calls: CallView[];
  choices: ChoiceView[];
  /** Option cards in a later step show what this text listed. */
  replaced?: boolean;
  usage?: UsageView;
}

export interface ChoiceView {
  runId: string;
  callId: string;
  card: ChoiceCard;
  status: "awaiting" | "answered" | "expired";
  answer?: string;
  index?: number;
}

export interface PlanView {
  steps: string[];
  status: "awaiting" | "accepted" | "cancelled";
}

export type CompactionView =
  | { status: "running" }
  | { status: "done"; kind: "pruned" | "summarized"; before: number; after: number; summary?: string };

export interface RunView {
  runId: string;
  goal: string;
  /** Files the user attached to the message. */
  attachments?: string[];
  model: string;
  status: "running" | RunStatus;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  /** Intent preview, when the task warranted one. */
  plan?: PlanView;
  /** Older turns condensed or trimmed after (or during) this run. */
  compaction?: CompactionView;
  /** Notes from memory the run was given, and notes it proposes to remember. */
  memory?: MemoryView;
  /** Work notes the run saved; a note saved twice shows once, with its last title. */
  notes?: { id: string; title: string; scope: "project" | "conversation"; deleted?: boolean }[];
  /** The model opened with a shorter context than its setting, for lack of memory. */
  lowered?: { context: number; wanted: number; tight: boolean };
  steps: StepView[];
}

export interface MemoryView {
  given: MemoryNote[];
  proposals: (MemoryProposal & { state: "open" | "saved" | "skipped" })[];
}

export function foldEvent(runs: RunView[], e: AgentEvent): RunView[] {
  if (e.type === "run.started") {
    return [
      ...runs,
      {
        runId: e.runId,
        goal: e.goal,
        ...(e.attachments?.length && { attachments: e.attachments }),
        model: e.model,
        status: "running",
        startedAt: e.at,
        steps: [],
      },
    ];
  }
  return runs.map((run) => (run.runId === e.runId ? foldIntoRun(run, e) : run));
}

function foldIntoRun(run: RunView, e: AgentEvent): RunView {
  switch (e.type) {
    case "plan.proposed":
      return { ...run, plan: { steps: e.steps, status: "awaiting" } };
    case "plan.resolved":
      return {
        ...run,
        plan:
          e.decision.kind === "go"
            ? { steps: e.decision.steps, status: "accepted" }
            : { steps: run.plan?.steps ?? [], status: "cancelled" },
      };
    case "step.started":
      return {
        ...run,
        steps: [...run.steps, { stepId: e.stepId, index: e.index, startedAt: e.at, thought: "", text: "", calls: [], choices: [] }],
      };
    case "thought.delta":
      return updateStep(run, e.stepId, (s) => ({ ...s, thought: s.thought + e.text }));
    case "message.delta":
      return updateStep(run, e.stepId, (s) => ({ ...s, text: s.text + e.text }));
    case "usage":
      return updateStep(run, e.stepId, (s) => ({
        ...s,
        usage: {
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          ttftMs: e.ttftMs,
          tokensPerSec: e.tokensPerSec,
          ...(e.ledger && { parts: ledgerTotals(e.ledger) }),
        },
      }));
    case "tool.proposed":
      if (e.tool === "ask_choice" || e.tool === "present_options") return run;
      return updateStep(run, e.stepId, (s) => ({
        ...s,
        calls: [
          ...s.calls,
          {
            callId: e.callId,
            tool: e.tool,
            args: e.args,
            actionClass: e.actionClass,
            status: "proposed",
            ...(e.preview !== undefined && { preview: e.preview }),
          },
        ],
      }));
    case "approval.required":
      return updateCall(run, e.callId, (c) => ({
        ...c,
        status: "awaiting",
        reason: e.reason,
        ...(e.alert === true && { alert: true }),
        ...(e.alwaysAsk === true && { alwaysAsk: true }),
        ...(e.switchedOff !== undefined && { switchedOff: e.switchedOff }),
      }));
    case "approval.resolved":
      return updateCall(run, e.callId, (c) => ({ ...c, status: decisionStatus(e.decision) }));
    case "handoff.required":
      return updateCall(run, e.callId, (c) => ({ ...c, handoff: e.reason }));
    case "handoff.resolved":
      return updateCall(run, e.callId, ({ handoff: _, ...c }) => c);
    case "choice.asked": {
      const asked = updateStep(run, e.stepId, (s) => ({ ...s, choices: [...s.choices, { runId: e.runId, callId: e.callId, card: e.card, status: "awaiting" }] }));
      return e.replaces ? updateStep(asked, e.replaces, (s) => ({ ...s, replaced: true })) : asked;
    }
    case "choice.answered":
      return { ...run, steps: run.steps.map((s) => ({ ...s, choices: s.choices.map((c) => c.callId === e.callId ? { ...c, status: "answered" as const, answer: e.text, ...(e.index !== undefined && { index: e.index }) } : c) })) };
    case "tool.started":
      return updateCall(run, e.callId, (c) => ({ ...c, status: "running" }));
    case "tool.finished":
      return updateCall(run, e.callId, (c) => ({
        ...c,
        // A refusal is reported through tool.finished too; keep it as "rejected".
        status: c.status === "rejected" ? "rejected" : e.ok ? "ok" : "error",
        // What the model was given may be shorter; the user sees all of it.
        output: e.display ?? e.output,
        ...(e.flagged && { flagged: e.flagged }),
        ...(e.artifact && { artifact: e.artifact }),
        ...(e.gallery?.length && { gallery: e.gallery }),
        ...(e.ok && e.produced && { files: producedFiles(e.callId, e.produced) }),
        durationMs: e.durationMs,
      }));
    case "run.finished":
      return {
        ...run,
        status: e.status,
        detail: e.detail,
        finishedAt: e.at,
        // A plan still on screen will never be answered now.
        ...(run.plan?.status === "awaiting" && { plan: { ...run.plan, status: "cancelled" as const } }),
        // Anything still waiting will never be answered now.
        steps: run.steps.map((s) => ({
          ...s,
          choices: s.choices.map((c) => c.status === "awaiting" ? { ...c, status: "expired" as const } : c),
          calls: s.calls.map((c) =>
            c.status === "awaiting" || c.status === "running" || c.status === "proposed"
              ? { ...withoutHandoff(c), status: e.status === "stopped" ? "rejected" : "error" }
              : c,
          ),
        })),
      };
    case "context.compacting":
      return { ...run, compaction: { status: "running" } };
    case "memory.given":
      return { ...run, memory: { given: e.notes, proposals: run.memory?.proposals ?? [] } };
    case "note.saved": {
      const notes = (run.notes ?? []).filter((n) => n.id !== e.noteId);
      return { ...run, notes: [...notes, { id: e.noteId, title: e.title, scope: e.scope }] };
    }
    case "model.context":
      return { ...run, lowered: { context: e.context, wanted: e.wanted, tight: e.tight } };
    case "memory.proposed":
      return {
        ...run,
        memory: { given: run.memory?.given ?? [], proposals: e.proposals.map((p) => ({ ...p, state: "open" as const })) },
      };
    case "memory.resolved":
      if (!run.memory) return run;
      return {
        ...run,
        memory: {
          ...run.memory,
          proposals: run.memory.proposals.map((p) =>
            p.id === e.proposalId ? { ...p, state: e.decision, ...(e.text && { text: e.text }) } : p,
          ),
        },
      };
    case "context.compacted": {
      if (e.kind === "unchanged") {
        const { compaction: _, ...rest } = run;
        return rest;
      }
      return {
        ...run,
        compaction: { status: "done", kind: e.kind, before: e.before, after: e.after, ...(e.summary && { summary: e.summary }) },
      };
    }
    default:
      return run;
  }
}

function withoutHandoff({ handoff: _, ...c }: CallView): CallView {
  return c;
}

function decisionStatus(d: ApprovalDecision): CallStatus {
  return d.kind === "reject" ? "rejected" : "proposed";
}

function updateStep(run: RunView, stepId: string, f: (s: StepView) => StepView): RunView {
  return { ...run, steps: run.steps.map((s) => (s.stepId === stepId ? f(s) : s)) };
}

function updateCall(run: RunView, callId: string, f: (c: CallView) => CallView): RunView {
  return {
    ...run,
    steps: run.steps.map((s) =>
      s.calls.some((c) => c.callId === callId)
        ? { ...s, calls: s.calls.map((c) => (c.callId === callId ? f(c) : c)) }
        : s,
    ),
  };
}

/** Aggregates for the run footer. */
export function runStats(run: RunView): { steps: number; tools: number; tokensPerSec: number | null; ttftMs: number | null; lastPromptTokens: number | null; lastParts: Partial<Record<LedgerKind, number>> | null } {
  const usages = run.steps.flatMap((s) => (s.usage ? [s.usage] : []));
  const tps = usages.flatMap((u) => (u.tokensPerSec !== null ? [u.tokensPerSec] : []));
  return {
    steps: run.steps.length,
    tools: run.steps.reduce((n, s) => n + s.calls.length + s.choices.length, 0),
    tokensPerSec: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null,
    ttftMs: usages[0]?.ttftMs ?? null,
    lastPromptTokens: usages.at(-1)?.promptTokens ?? null,
    lastParts: usages.at(-1)?.parts ?? null,
  };
}

/**
 * What Vunemi would say out loud at the end of a run: the last thing it wrote
 * to the user, with markdown scaffolding stripped so it isn't read aloud.
 */
export function replyText(run: RunView | undefined): string {
  const last = [...(run?.steps ?? [])].reverse().find((s) => s.text.trim() !== "");
  return speakable(last?.text ?? "");
}

function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ` ${t("voice.codeBlock")} `)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The one thing Vunemi is waiting for the user to do, if any. */
export function pendingHandoff(runs: readonly RunView[]): { callId: string; reason: string } | null {
  for (const run of [...runs].reverse()) {
    for (const step of [...run.steps].reverse()) {
      const call = step.calls.find((c) => c.handoff);
      if (call?.handoff) return { callId: call.callId, reason: call.handoff };
    }
  }
  return null;
}

/** True while a question or option cards wait for the user's pick. */
export function awaitingChoice(runs: readonly RunView[]): boolean {
  return runs.at(-1)?.steps.some((step) => step.choices.some((choice) => choice.status === "awaiting")) ?? false;
}

/**
 * A draft that option cards replaced, as plain words: link addresses go,
 * since nothing checked them. The cards carry the sources that were read.
 */
export function draftText(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)\s]+\)/g, "$1").replace(/\s*https?:\/\/\S+/g, "").trim();
}

/** True while an intent preview is waiting for a yes. */
export function planAwaiting(runs: readonly RunView[]): boolean {
  return runs.some((r) => r.plan?.status === "awaiting");
}

/** Approval cards still unanswered. */
export function pendingApprovals(runs: readonly RunView[]): number {
  return runs.reduce(
    (n, run) => n + run.steps.reduce((m, s) => m + s.calls.filter((c) => c.status === "awaiting" && !c.handoff).length, 0),
    0,
  );
}

/** Ids match the Artefacts store: `<callId>:<index in produced>`. */
function producedFiles(callId: string, produced: Produced[]): { id: string; name: string }[] {
  return produced.flatMap((item, n) =>
    item.kind === "file" || item.kind === "download" ? [{ id: `${callId}:${n}`, name: item.path.split("/").pop() || item.path }] : [],
  );
}
