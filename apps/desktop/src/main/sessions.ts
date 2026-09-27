/**
 * Conversations, kept. Each one is a file: what the model remembers (its
 * history) and what the user saw (the event stream the timeline is folded
 * from), so opening an old conversation shows it exactly as it was and the
 * agent carries on from where it left off.
 *
 * One conversation is current at a time — the agent runs one task at a time
 * — and the others wait on disk. A conversation with nothing in it is never
 * written, so pressing "Yeni oturum" twice does not leave empty files behind.
 *
 * The events are stored compacted. The stream arrives a few characters at a
 * time; stored as it came, a single answer would be hundreds of entries. The
 * deltas of one step are joined into one, which folds to the same timeline.
 *
 * A run in progress is not in that file: it is kept beside it as a
 * checkpoint, rewritten after every step and removed when the run ends. If
 * Vunemi quits without ending it (a crash, a power cut), the next start folds
 * the checkpoint into the conversation, marked as cut short, so the user can
 * pick it up again. Nothing resumes on its own.
 *
 * The files hold what the agent read, so they are written for the user's
 * eyes only (0600). Secrets never reach them: the Vault masks them before
 * the model, and so before the history, ever sees them.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealInterrupted, type AgentEvent, type ChatMessage } from "@ocak/agent-core";
import type { SessionSummary } from "../shared/ipc.js";
import { t } from "@ocak/i18n";

interface StoredSession {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  history: ChatMessage[];
  events: AgentEvent[];
  /** Its last task was cut short by Vunemi closing; cleared when the next one starts or the user lets it go. */
  interrupted?: { steps: number; at: number };
  /** The project it belongs to, if any. */
  projectId?: string;
}

/** A run in progress, as of its last step. */
interface Checkpoint {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  at: number;
  events: AgentEvent[];
  messages: ChatMessage[];
  projectId?: string;
}

const CHECKPOINT = ".checkpoint";
/** Answers a call that was under way when Vunemi closed. For the model. */
export const CLOSED_MID_CALL = "[Vunemi closed before this tool reported back. It may or may not have taken effect: check before doing it again.]";
/** Ends a transcript that Vunemi's closing cut short. For the model. */
export const CLOSED_MID_TASK = "[Vunemi closed here, before this task was finished.]";

const ID = /^s_[a-z0-9]{6,40}$/;
/** A tool's raw output is for the model; the timeline shows a glimpse of it. */
const MAX_STORED_OUTPUT = 20_000;
const TITLE_CHARS = 80;

export class SessionStore {
  private current: StoredSession;
  private readonly summaries = new Map<string, SessionSummary>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const stored = this.read(name.slice(0, -".json".length));
      if (stored) this.summaries.set(stored.id, summaryOf(stored));
    }
    for (const name of readdirSync(dir)) {
      if (name.endsWith(CHECKPOINT)) this.recover(name.slice(0, -CHECKPOINT.length));
    }
    this.current = this.blank();
  }

  /** Conversations whose last task Vunemi's closing cut short, newest first. */
  get interrupted(): string[] {
    return this.list().filter((s) => s.interrupted).map((s) => s.id);
  }

  get currentId(): string {
    return this.current.id;
  }

  /** The project the current conversation belongs to, if any. */
  get currentProject(): string | undefined {
    return this.current.projectId;
  }

  /** Newest first. The current conversation is listed once it has something in it. */
  list(): SessionSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Whether a task ran in the current conversation. */
  hasRun(runId: string): boolean {
    return this.current.events.some((e) => e.type === "run.started" && e.runId === runId);
  }

  /** Feeds on the same event stream as the UI. */
  record(event: AgentEvent): void {
    const s = this.current;
    if (event.type === "run.started") {
      if (s.title === "") s.title = event.goal.trim().slice(0, TITLE_CHARS);
      delete s.interrupted;
    }
    appendCompacted(s.events, event);
    s.updatedAt = this.now();
    // A finished task is the moment worth keeping; mid-run there is nothing
    // to reopen that would not be missing its end.
    if (event.type === "run.finished") {
      this.save();
      rmSync(this.checkpointFile(s.id), { force: true });
    }
  }

  /** Keeps the run in progress, as of this step. */
  checkpoint(messages: ChatMessage[]): void {
    const s = this.current;
    const point: Checkpoint = {
      version: 1, id: s.id, title: s.title, createdAt: s.createdAt, at: this.now(), events: s.events, messages,
      ...(s.projectId && { projectId: s.projectId }),
    };
    writeWhole(this.checkpointFile(s.id), JSON.stringify(point));
  }

  /** The user chose not to pick the cut-short task up again. */
  dismissInterrupted(): void {
    if (!this.current.interrupted) return;
    delete this.current.interrupted;
    this.save();
  }

  /** What the model remembers, after each task. */
  setHistory(history: ChatMessage[]): void {
    this.current.history = history;
    if (this.current.events.length > 0) this.save();
  }

  /** Starts a fresh conversation. The current one is already on disk if it had anything in it. */
  /** A new conversation; `title` names it now rather than after its first task. */
  create(title?: string, projectId?: string): string {
    if (this.current.events.length > 0) this.current = this.blank();
    if (title) this.current.title = title.slice(0, TITLE_CHARS);
    if (projectId) this.current.projectId = projectId;
    else delete this.current.projectId;
    return this.current.id;
  }

  /** Makes a stored conversation current, and hands back what it needs to be shown and continued. */
  open(id: string): { history: ChatMessage[]; events: AgentEvent[] } {
    const stored = ID.test(id) ? this.read(id) : null;
    if (!stored) throw new Error(t("sessions.notFound"));
    this.current = stored;
    return { history: stored.history, events: stored.events };
  }

  /** Forgets one conversation. Forgetting the current one starts a fresh one. */
  remove(id: string): void {
    if (!ID.test(id)) return;
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(this.checkpointFile(id), { force: true });
    this.summaries.delete(id);
    if (id === this.current.id) this.current = this.blank();
  }

  /** Forgets all of them. */
  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.summaries.clear();
    this.current = this.blank();
  }

  private blank(): StoredSession {
    const at = this.now();
    const id = `s_${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return { version: 1, id, title: "", createdAt: at, updatedAt: at, history: [], events: [] };
  }

  // Written only when a task has finished (record, setHistory), so a file
  // never holds a run without its end.
  private save(): void {
    this.write(this.current);
  }

  private write(s: StoredSession): void {
    writeWhole(join(this.dir, `${s.id}.json`), JSON.stringify(s));
    this.summaries.set(s.id, summaryOf(s));
  }

  private checkpointFile(id: string): string {
    return join(this.dir, `${id}${CHECKPOINT}`);
  }

  /**
   * Folds a checkpoint left by a run that never ended into its conversation:
   * calls that were under way are answered as unknown, the transcript is
   * marked as cut short, and the timeline gets the ending it never had.
   * An unreadable checkpoint is left where it is.
   */
  private recover(id: string): void {
    if (!ID.test(id)) return;
    let point: Checkpoint;
    try {
      point = JSON.parse(readFileSync(this.checkpointFile(id), "utf8")) as Checkpoint;
      if (point?.version !== 1 || point.id !== id || !Array.isArray(point.events) || !Array.isArray(point.messages)) return;
    } catch {
      return;
    }
    const kept = this.read(id);
    const runId = point.events.findLast((e) => e.type === "run.started")?.runId ?? "run_recovered";
    const history = [...sealInterrupted(point.messages, CLOSED_MID_CALL), { role: "assistant" as const, content: CLOSED_MID_TASK }];
    this.write({
      version: 1,
      id,
      title: point.title || kept?.title || "",
      createdAt: kept?.createdAt ?? point.createdAt,
      updatedAt: point.at,
      history,
      events: [...point.events, { type: "run.finished", runId, status: "stopped", detail: t("sessions.interrupted"), at: point.at }],
      interrupted: { steps: stepsDone(point.messages), at: point.at },
      ...((point.projectId ?? kept?.projectId) && { projectId: point.projectId ?? kept?.projectId }),
    });
    rmSync(this.checkpointFile(id), { force: true });
  }

  private read(id: string): StoredSession | null {
    try {
      const value = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as StoredSession;
      if (value?.version !== 1 || value.id !== id || !Array.isArray(value.events) || !Array.isArray(value.history)) return null;
      return value;
    } catch {
      // Unreadable is left alone rather than deleted: it may be a newer
      // version's file, and it is the user's conversation either way.
      return null;
    }
  }
}

function summaryOf(s: StoredSession): SessionSummary {
  return {
    id: s.id,
    // Empty until the first task; the window names it in its own language.
    title: s.title,
    updatedAt: s.updatedAt,
    runs: s.events.filter((e) => e.type === "run.started").length,
    ...(s.interrupted && { interrupted: s.interrupted }),
    ...(s.projectId && { projectId: s.projectId }),
  };
}

/** Whole file, then a rename: a crash mid-write leaves the old one intact. */
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Tool answers since the task's request: what the cut-short run got done. */
function stepsDone(messages: readonly ChatMessage[]): number {
  const start = messages.findLastIndex((m) => m.role === "user" && m.content.startsWith("<user_request>"));
  return messages.slice(start + 1).filter((m) => m.role === "tool").length;
}

/** Joins a step's streamed pieces into one event, and trims what only the model needs in full. */
export function appendCompacted(events: AgentEvent[], event: AgentEvent): void {
  const last = events.at(-1);
  if (
    (event.type === "thought.delta" || event.type === "message.delta") &&
    last?.type === event.type &&
    last.stepId === event.stepId
  ) {
    events[events.length - 1] = { ...last, text: last.text + event.text };
    return;
  }
  if (event.type === "tool.finished" && event.output.length > MAX_STORED_OUTPUT) {
    events.push({ ...event, output: `${event.output.slice(0, MAX_STORED_OUTPUT)}\n[…]` });
    return;
  }
  events.push(event);
}
