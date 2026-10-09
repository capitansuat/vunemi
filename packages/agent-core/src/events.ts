/**
 * Event Stream protocol — the only contract between the agent core and any UI.
 *
 * The core emits these events in order; a UI renders by folding them into
 * state. Nothing flows back through this channel: user decisions (approvals,
 * stop) arrive through `RunControls`, never by mutating events.
 */

import type { ActionClass } from "./tools.js";
import type { LedgerPart } from "./ledger.js";

export type RunStatus = "done" | "stopped" | "failed" | "max_steps";

/** A bounded question or comparison shown inside a chat turn. */
export type ChoiceCard =
  | { kind: "choice"; question: string; options: string[]; allowOther: boolean }
  /** `unchecked`: nothing was read in the run, so the cards are the model's own suggestions and carry no marks. */
  | { kind: "options"; intro?: string; items: OptionCard[]; unchecked?: true };

export interface OptionCard {
  title: string;
  price?: VerifiedFact;
  facts: VerifiedFact[];
  view?: string;
  sourceUrl?: string;
}

export interface VerifiedFact {
  label: string;
  value: string;
  /** An exact value match in a read page or local connector result, not a truth guarantee. */
  status: "page" | "local" | "unverified";
}

/** A conversation or meeting the user brought into a request with "@". The title is the name they saw. */
export interface MentionRef {
  kind: "conversation" | "meeting";
  id: string;
  title: string;
}

export type AgentEvent =
  | { type: "run.started"; runId: string; goal: string; attachments?: string[]; mentions?: MentionRef[]; model: string; at: number }
  | { type: "step.started"; runId: string; stepId: string; index: number; at: number }
  /** Model reasoning, streamed. UIs should render it demoted and collapsible. */
  | { type: "thought.delta"; runId: string; stepId: string; text: string }
  /** User-facing answer text, streamed. */
  | { type: "message.delta"; runId: string; stepId: string; text: string }
  | {
      type: "tool.proposed";
      runId: string;
      stepId: string;
      callId: string;
      tool: string;
      args: unknown;
      actionClass: ActionClass;
      /** Human-readable summary of the call, when the tool provides one. */
      preview?: string;
    }
  | {
      type: "approval.required";
      runId: string;
      stepId: string;
      callId: string;
      tool: string;
      args: unknown;
      actionClass: ActionClass;
      reason: string;
      /** The reason is a warning the user must read, not routine policy. */
      alert?: boolean;
      /** The tool asks every time; "always allow" does not apply. */
      alwaysAsk?: boolean;
      preview?: string;
      /**
       * The tool is switched off, and this is its connection and part in the
       * user's words. Approving runs it once; "always" switches the part on.
       */
      switchedOff?: string;
    }
  | {
      type: "approval.resolved";
      runId: string;
      callId: string;
      decision: ApprovalDecision;
    }
  /**
   * A tool needs the user to do something only they may do (a CAPTCHA, a
   * login) and is waiting. The UI shows where and offers Continue / Cancel.
   */
  | { type: "handoff.required"; runId: string; callId: string; reason: string; at: number }
  | { type: "handoff.resolved"; runId: string; callId: string; outcome: HandoffOutcome }
  /** A bounded, read-only decision inside an ordinary chat turn. */
  // `replaces`: the step whose text these cards stand in for, so it is not shown twice.
  | { type: "choice.asked"; runId: string; stepId: string; callId: string; card: ChoiceCard; replaces?: string; at: number }
  | { type: "choice.answered"; runId: string; callId: string; text: string; index?: number; at: number }
  /** Short answers to the question an answer ends on. Nothing waits for them: picking one is the user's next message. */
  | { type: "replies.offered"; runId: string; stepId: string; options: string[]; at: number }
  /** Intent preview: what the agent means to do, before it starts. */
  | { type: "plan.proposed"; runId: string; steps: string[]; at: number }
  | { type: "plan.resolved"; runId: string; decision: PlanDecision }
  /** The user paused the run (to look, or to take over the page); nothing runs until resumed. */
  | { type: "run.paused"; runId: string; at: number }
  | { type: "run.resumed"; runId: string; at: number }
  | { type: "tool.started"; runId: string; callId: string; at: number }
  | {
      type: "tool.finished";
      runId: string;
      callId: string;
      ok: boolean;
      /** Text handed back to the model (already truncated / wrapped). */
      output: string;
      /** The whole output for the UI, when the model was given less (ToolDef.forModel). */
      display?: string;
      /** Text in the output that reads as instructions to the assistant (see guard.ts). */
      flagged?: string;
      /** Something the call produced that isn't text, for the user to look at. */
      artifact?: Artifact;
      /** Pictures for the person only (see ToolContext.gallery). */
      gallery?: Artifact[];
      /** What the call left behind for the user; only on success. */
      produced?: Produced[];
      durationMs: number;
    }
  | {
      type: "usage";
      runId: string;
      stepId: string;
      promptTokens: number | null;
      completionTokens: number | null;
      ttftMs: number | null;
      tokensPerSec: number | null;
      /** What the request was made of, by part; names only, never content. */
      ledger?: LedgerPart[];
    }
  /** The notes from memory this run was given; shown under its answer. */
  | { type: "memory.given"; runId: string; notes: MemoryNote[]; at: number }
  /** What Vunemi would like to remember from the run, waiting for the user's yes. */
  | { type: "memory.proposed"; runId: string; proposals: MemoryProposal[]; at: number }
  | { type: "memory.resolved"; runId: string; proposalId: string; decision: "saved" | "skipped"; text?: string; at: number }
  /** The model saved a work note (worknote_write); the timeline shows its title. */
  | { type: "note.saved"; runId: string; noteId: string; title: string; scope: "project" | "conversation"; at: number }
  /** The chat model opened with a shorter context than its setting, for lack of memory (`tight`: not even the shortest fitted). */
  | { type: "model.context"; runId: string; context: number; wanted: number; tight: boolean; at: number }
  /** Older turns are being condensed; the UI shows it under the run it follows. */
  | { type: "context.compacting"; runId: string; at: number }
  | {
      type: "context.compacted";
      runId: string;
      /** "unchanged": asked, but nothing could be made smaller. */
      kind: "pruned" | "summarized" | "unchanged";
      /** Estimated tokens of the next request, before and after. */
      before: number;
      after: number;
      window: number;
      /** The summary text, for the user to read; already redacted. */
      summary?: string;
      at: number;
    }
  | {
      type: "run.finished";
      runId: string;
      status: RunStatus;
      /** Final answer text when status is "done"; error message when "failed". */
      detail: string;
      at: number;
    };

/**
 * A file a tool made that the user should see — today a screenshot. It is
 * shown in the UI, not sent to the model: a text model has no use for it, and
 * a vision model will take it through a different door.
 */
export interface Artifact {
  kind: "image";
  /** Absolute path, inside the app's own folder. */
  path: string;
  label?: string;
}

/**
 * Something the agent made that outlives the run: a file, a draft, an
 * event. Distinct from an Artifact, which is a picture for the call card —
 * this is the list the user comes back to later ("what did it make?").
 *
 * Never shown to the model. It already has the tool's result; paths and
 * titles here are for the person.
 */
export type Produced =
  /** A file in the user's own folders. */
  | { kind: "file"; path: string }
  /** A draft saved in a mailbox. */
  | { kind: "draft"; account: string; subject: string; to: string[] }
  /** A calendar event it created. */
  | { kind: "event"; title: string; start: string; calendar?: string }
  /** A reminder it created. */
  | { kind: "reminder"; title: string; due?: string; list?: string }
  /** A file a page downloaded while the agent worked. */
  | { kind: "download"; path: string };

export type HandoffOutcome = "done" | "cancelled";

export type PlanDecision =
  /** Go ahead — with these steps, which the user may have edited. */
  | { kind: "go"; steps: string[] }
  | { kind: "cancel" };

export type ApprovalDecision =
  | { kind: "approve" }
  /** Approve and stop asking for this tool for the rest of the session. */
  | { kind: "approve_always" }
  | { kind: "reject"; note?: string };

export type EmitFn = (event: AgentEvent) => void;

export interface MemoryNote {
  id: string;
  text: string;
  kind: "general" | "topic";
}

export interface MemoryProposal {
  id: string;
  text: string;
  kind: "general" | "topic";
  /** The user's own words it came from. */
  quote: string;
  /** The note it would replace. */
  updates?: { id: string; text: string };
}
