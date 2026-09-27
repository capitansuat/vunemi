/**
 * The activity log: everything the agent did, kept apart from the chat and
 * outliving it. One JSON object per line, appended as it happens, so a crash
 * can't lose the record and it can be read with any text tool.
 *
 * Undo lives only for the life of the app: a tool offers a closure that can
 * reverse what it just did (see ToolContext.offerUndo). Entries read back
 * from disk after a restart are history, not actions.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionClass, AgentEvent } from "@ocak/agent-core";
import type { ActivityEntry } from "../shared/ipc.js";
import { t } from "@ocak/i18n";

const MAX_IN_MEMORY = 500;
const FILE = "activity.jsonl";

interface Undo {
  label: string;
  fn: () => Promise<void>;
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private loaded = false;
  private readonly goals = new Map<string, string>();
  private readonly open = new Map<string, ActivityEntry>();
  private readonly undos = new Map<string, Undo>();
  private readonly listeners = new Set<(entries: ActivityEntry[]) => void>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async list(): Promise<ActivityEntry[]> {
    if (!this.loaded) {
      this.loaded = true;
      const older = await this.read();
      // Anything already recorded this session is newer than the file.
      const known = new Set(this.entries.map((e) => e.id));
      this.entries = [...older.filter((e) => !known.has(e.id)), ...this.entries].slice(-MAX_IN_MEMORY);
    }
    return [...this.entries].reverse(); // newest first
  }

  onChange(listener: (entries: ActivityEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async clear(): Promise<void> {
    await this.writing;
    await writeFile(join(this.dir, FILE), "", "utf8");
    this.entries = [];
    this.goals.clear();
    this.open.clear();
    this.undos.clear();
    this.loaded = true;
    this.changed();
  }

  offerUndo(callId: string, label: string, fn: () => Promise<void>): void {
    this.undos.set(callId, { label, fn });
    const entry = this.entries.find((e) => e.id === callId);
    if (entry) this.update(entry, { undo: label });
  }

  /** Runs the undo a tool offered. Each one is used at most once. */
  async undo(id: string): Promise<{ runId: string; label: string }> {
    const entry = this.entries.find((e) => e.id === id);
    const undo = this.undos.get(id);
    if (!entry || !undo) throw new Error(t("main.undoGone"));
    this.undos.delete(id);
    try {
      await undo.fn();
    } catch (err) {
      // A remote undo can fail temporarily; keep it available to retry.
      if (this.entries.includes(entry) && !this.undos.has(id)) this.undos.set(id, undo);
      this.changed();
      throw err;
    }
    this.update(entry, { undone: true, undo: undefined });
    return { runId: entry.runId, label: undo.label };
  }

  /**
   * Records something that happened while the agent worked but wasn't a tool
   * call of its own — a file a page downloaded, say. Same log, same undo.
   */
  note(opts: {
    tool: string;
    actionClass: ActionClass;
    preview: string;
    result?: string;
    runId?: string;
    undo?: { label: string; fn: () => Promise<void> };
  }): string {
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const runId = opts.runId ?? [...this.goals.keys()].at(-1) ?? "";
    const entry: ActivityEntry = {
      id,
      at: Date.now(),
      runId,
      goal: this.goals.get(runId) ?? "",
      tool: opts.tool,
      actionClass: opts.actionClass,
      status: "ok",
      preview: opts.preview,
      ...(opts.result !== undefined && { result: opts.result }),
      ...(opts.undo && { undo: opts.undo.label }),
    };
    if (opts.undo) this.undos.set(id, opts.undo);
    this.add(entry);
    this.append(entry);
    return id;
  }

  /** Whether the undo for this call is still held. Only this session's are. */
  canUndo(id: string): boolean {
    return this.undos.has(id);
  }

  /** Feeds on the same event stream the UI gets. */
  record(event: AgentEvent): void {
    switch (event.type) {
      case "run.started":
        this.goals.set(event.runId, event.goal);
        return;
      case "run.finished":
        this.goals.delete(event.runId);
        return;
      case "tool.proposed": {
        const entry: ActivityEntry = {
          id: event.callId,
          at: Date.now(),
          runId: event.runId,
          goal: this.goals.get(event.runId) ?? "",
          tool: event.tool,
          actionClass: event.actionClass,
          status: "running",
          ...(event.preview !== undefined && { preview: event.preview }),
        };
        this.open.set(event.callId, entry);
        this.add(entry);
        return;
      }
      case "approval.resolved": {
        if (event.decision.kind !== "reject") return;
        const entry = this.open.get(event.callId);
        if (entry) this.update(entry, { status: "refused" });
        return;
      }
      case "tool.finished": {
        const entry = this.open.get(event.callId);
        this.open.delete(event.callId);
        if (!entry) return;
        const undo = this.undos.get(event.callId);
        this.update(entry, {
          status: entry.status === "refused" ? "refused" : event.ok ? "ok" : "error",
          result: event.output.slice(0, 400),
          durationMs: event.durationMs,
          ...(undo && { undo: undo.label }),
        });
        return;
      }
      case "handoff.required": {
        const entry = this.open.get(event.callId);
        if (entry) this.update(entry, { status: "waiting-user" });
        return;
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private add(entry: ActivityEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_IN_MEMORY) this.entries.shift();
    this.changed();
  }

  private update(entry: ActivityEntry, patch: Partial<ActivityEntry>): void {
    Object.assign(entry, patch);
    if (patch.undo === undefined && "undo" in patch) delete entry.undo;
    // Written once settled, so the file holds outcomes rather than intentions.
    if (entry.status !== "running" && entry.status !== "waiting-user") this.append(entry);
    this.changed();
  }

  private append(entry: ActivityEntry): void {
    const line = `${JSON.stringify({ ...entry, undo: undefined })}\n`;
    this.writing = this.writing
      .then(() => appendFile(join(this.dir, FILE), line, "utf8"))
      .catch((err: unknown) => console.error("[ocak] activity log:", err));
  }

  private async read(): Promise<ActivityEntry[]> {
    try {
      const text = await readFile(join(this.dir, FILE), "utf8");
      return text
        .split("\n")
        .slice(-MAX_IN_MEMORY)
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line) as ActivityEntry];
          } catch {
            return []; // a half-written last line after a crash
          }
        });
    } catch {
      return []; // no log yet
    }
  }

  private changed(): void {
    const snapshot = [...this.entries].reverse();
    for (const l of this.listeners) l(snapshot);
  }
}
