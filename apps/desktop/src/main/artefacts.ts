/**
 * Artefacts: what Vunemi made, for the screen the user comes back to.
 *
 * Kept apart from the activity log on purpose. The log is every click and
 * keeps the last few hundred; a report written yesterday would scroll out of
 * it under one busy afternoon of browsing. Things made are rare and worth
 * keeping, so they get their own small file.
 *
 * The same shape as the log: one JSON object per line, appended, so a crash
 * cannot lose the record. A later line for the same id replaces the earlier
 * one — that is how "undone" is written down.
 *
 * Nothing here opens anything. It holds the record; the caller decides, with
 * openable() and the folder rules, what a click may do. The renderer never
 * hands a path back — it names an artefact, and the path comes from here.
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentEvent, Produced } from "@vunemi/agent-core";

const FILE = "artefacts.jsonl";
const MAX_KEPT = 2_000;

export interface ArtefactRecord {
  /** `${callId}:${n}` — a call can make several things. */
  id: string;
  callId: string;
  at: number;
  /** The task it was made for, in the user's words. */
  goal: string;
  tool: string;
  item: Produced;
  undone?: boolean;
}

/**
 * Extensions a click may open with the default app. An allowlist, because
 * the dangerous set is open-ended: a page the agent read can get it to write
 * or download a .command, an .app or a .terminal, and opening one runs it.
 * HTML and SVG are out too — they open in a browser, and they carry script.
 * Everything else can still be shown in Finder, where the user decides.
 */
const OPENABLE = new Set([
  ".txt", ".md", ".rtf", ".pdf", ".csv", ".json",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".pages", ".numbers", ".key",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff", ".bmp",
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".mp4", ".mov", ".m4v",
]);

export function openable(path: string): boolean {
  return OPENABLE.has(extname(path).toLowerCase());
}

/** Files are one thing however often they were written; the rest are events. */
function identity(record: ArtefactRecord): string {
  const item = record.item;
  return item.kind === "file" || item.kind === "download" ? `path:${item.path}` : record.id;
}

export class ArtefactStore {
  private records = new Map<string, ArtefactRecord>();
  private readonly goals = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Feeds on the same event stream as the UI and the activity log. */
  record(event: AgentEvent): void {
    if (event.type === "run.started") this.goals.set(event.runId, event.goal);
    else if (event.type === "run.finished") this.goals.delete(event.runId);
    else if (event.type === "tool.finished" && event.ok && event.produced?.length) {
      this.add(event.callId, "", event.produced, event.runId);
    }
  }

  /** Records what a call made. Also used for things no tool call made, like downloads. */
  add(callId: string, tool: string, items: Produced[], runId?: string): void {
    const goal = (runId && this.goals.get(runId)) || [...this.goals.values()].at(-1) || "";
    const at = Date.now();
    items.forEach((item, n) => {
      this.put({ id: `${callId}:${n}`, callId, at, goal, tool, item });
    });
    this.changed();
  }

  /** The user took it back; it is no longer something Vunemi made. */
  markUndone(callId: string): void {
    let touched = false;
    for (const record of this.records.values()) {
      if (record.callId === callId && !record.undone) {
        this.put({ ...record, undone: true });
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  /** Newest first, without what was undone, each file once. */
  async list(): Promise<ArtefactRecord[]> {
    await this.load();
    const newest = [...this.records.values()].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const seen = new Set<string>();
    const out: ArtefactRecord[] = [];
    for (const record of newest) {
      // An undone record does not claim its file: undoing a rewrite puts
      // the earlier version back, and the call that made that one is what
      // the file is again.
      if (record.undone) continue;
      const key = identity(record);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(record);
    }
    return out;
  }

  async get(id: string): Promise<ArtefactRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async clear(): Promise<void> {
    await this.load();
    await this.writing;
    await writeFile(join(this.dir, FILE), "", "utf8");
    this.records.clear();
    this.goals.clear();
    this.changed();
  }

  /** Resolves once everything recorded so far is on disk. For tests and shutdown. */
  async flushed(): Promise<void> {
    await this.writing;
  }

  // -- internals -------------------------------------------------------------

  private put(record: ArtefactRecord): void {
    this.records.set(record.id, record);
    if (this.records.size > MAX_KEPT) {
      const oldest = [...this.records.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) this.records.delete(oldest.id);
    }
    const line = `${JSON.stringify(record)}\n`;
    this.writing = this.writing
      .then(() => appendFile(join(this.dir, FILE), line, { encoding: "utf8", mode: 0o600 }))
      .catch((err: unknown) => console.error("[vunemi] artefacts:", err));
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const recent = new Map(this.records);
      for (const record of await this.read()) {
        // Anything recorded in this session is newer than the file.
        if (!recent.has(record.id)) this.records.set(record.id, record);
      }
    })();
    return this.loaded;
  }

  private async read(): Promise<ArtefactRecord[]> {
    let text = "";
    try {
      text = await readFile(join(this.dir, FILE), "utf8");
    } catch {
      return []; // nothing made yet
    }
    const latest = new Map<string, ArtefactRecord>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as ArtefactRecord;
        if (record && typeof record.id === "string" && record.item && typeof record.item.kind === "string") {
          latest.set(record.id, record); // later lines win: that is how undone is kept
        }
      } catch {
        // a half-written last line after a crash
      }
    }
    return [...latest.values()].slice(-MAX_KEPT);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
