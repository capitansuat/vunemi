/**
 * The work archive: long tool output kept whole for its conversation, and
 * the notes the model writes on purpose (worknote_write), shared by the
 * conversations of a project. Apart from memory.db: memory holds what the
 * user approved, this holds what the model wrote. See
 * tenami/docs/superpowers/specs/2026-10-04-work-archive-design.md.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keywordQuery } from "../memory/store.js";

export interface WorkNote {
  id: string;
  /** `project:<id>` or `conversation:<id>`. */
  scope: string;
  /** The conversation that wrote it. */
  conversationId: string;
  title: string;
  text: string;
  /** Where untrusted content the writing conversation had read came from; empty when none. */
  sources: string[];
  createdAt: number;
  updatedAt: number;
}

export const NOTE_LIMITS = { title: 80, text: 4_000, perScope: 200 } as const;
const OUTPUTS_PER_CONVERSATION = 30;
const OUTPUT_BYTES = 20 * 1024 * 1024;
const UNUSED_MS = 30 * 86_400_000;
const SEARCH_HITS = 10;

export const projectScope = (id: string): string => `project:${id}`;
export const conversationScope = (id: string): string => `conversation:${id}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outputs (
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  tool TEXT NOT NULL,
  text TEXT NOT NULL,
  part INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, id)
);
CREATE TABLE IF NOT EXISTS output_counters (
  conversation_id TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  text TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, title_key)
);
CREATE INDEX IF NOT EXISTS notes_scope ON notes(scope, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, text, content='notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO notes_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
PRAGMA user_version = 1;
`;

interface NoteRow {
  id: string;
  scope: string;
  conversation_id: string;
  title: string;
  title_key: string;
  text: string;
  sources: string;
  created_at: number;
  updated_at: number;
}

export class WorkStore {
  private readonly db: DatabaseSync;

  constructor(dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "work.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    // A deleted note or output is overwritten on disk, not just unlinked.
    this.db.exec("PRAGMA secure_delete = ON;");
    this.db.exec(SCHEMA);
    // Deleted and replaced notes leave no words behind in the search index.
    this.db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1);");
  }

  close(): void {
    this.db.close();
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // -- outputs ----------------------------------------------------------------

  addOutput(conversationId: string, tool: string, text: string, part: number): string {
    let id = "";
    this.transaction(() => {
      const at = this.now();
      const counter = this.db.prepare("SELECT next FROM output_counters WHERE conversation_id = ?").get(conversationId) as { next: number } | undefined;
      const n = counter?.next ?? 1;
      this.db.prepare("INSERT INTO output_counters (conversation_id, next) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET next = excluded.next").run(conversationId, n + 1);
      id = `o${n}`;
      this.db
        .prepare("INSERT INTO outputs (conversation_id, id, tool, text, part, bytes, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(conversationId, id, tool, text, part, Buffer.byteLength(text), at, at);
      const newRowid = (this.db.prepare("SELECT rowid FROM outputs WHERE conversation_id = ? AND id = ?").get(conversationId, id) as { rowid: number }).rowid;
      this.db
        .prepare(`DELETE FROM outputs WHERE conversation_id = ? AND rowid NOT IN (SELECT rowid FROM outputs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${OUTPUTS_PER_CONVERSATION})`)
        .run(conversationId, conversationId);
      this.trimBytes(newRowid);
    });
    return id;
  }

  /** A kept output of this conversation; reading it counts as using it. */
  output(conversationId: string, id: string): { tool: string; text: string; part: number } | null {
    const row = this.db.prepare("SELECT tool, text, part FROM outputs WHERE conversation_id = ? AND id = ?").get(conversationId, id) as
      | { tool: string; text: string; part: number }
      | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE outputs SET used_at = ? WHERE conversation_id = ? AND id = ?").run(this.now(), conversationId, id);
    return { tool: row.tool, text: row.text, part: row.part };
  }

  /** The tool that made a kept output, without loading its text or counting as a use. */
  outputTool(conversationId: string, id: string): string | undefined {
    const row = this.db.prepare("SELECT tool FROM outputs WHERE conversation_id = ? AND id = ?").get(conversationId, id) as { tool: string } | undefined;
    return row?.tool;
  }

  /** At launch: outputs nobody read for 30 days go. */
  prune(): void {
    this.db.prepare("DELETE FROM outputs WHERE used_at < ?").run(this.now() - UNUSED_MS);
  }

  private trimBytes(excludeRowid: number = -1): void {
    let total = (this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM outputs").get() as { n: number }).n;
    while (total > OUTPUT_BYTES) {
      const oldest = this.db.prepare("SELECT rowid, bytes FROM outputs WHERE rowid != ? ORDER BY used_at, rowid LIMIT 1").get(excludeRowid) as { rowid: number; bytes: number } | undefined;
      if (!oldest) return;
      this.db.prepare("DELETE FROM outputs WHERE rowid = ?").run(oldest.rowid);
      total -= oldest.bytes;
    }
  }

  // -- notes ------------------------------------------------------------------

  writeNote(input: { scope: string; conversationId: string; title: string; text: string; sources: string[] }): { note: WorkNote; replaced: boolean } {
    const title = input.title.replace(/\s+/g, " ").trim();
    const text = input.text.trim();
    if (!title || title.length > NOTE_LIMITS.title) throw new Error(`A note needs a title of 1–${NOTE_LIMITS.title} characters.`);
    if (!text) throw new Error("A note needs some text.");
    if (text.length > NOTE_LIMITS.text) throw new Error(`A note may hold at most ${NOTE_LIMITS.text.toLocaleString("en-GB")} characters; shorten it or split it under two titles.`);
    const at = this.now();
    const titleKey = title.normalize("NFC").toLowerCase();
    const old = this.readNote(input.scope, title);
    if (old) {
      let result: { note: WorkNote; replaced: boolean } = null!;
      this.transaction(() => {
        this.db
          .prepare("UPDATE notes SET title = ?, title_key = ?, text = ?, sources = ?, conversation_id = ?, updated_at = ? WHERE id = ?")
          .run(title, titleKey, text, JSON.stringify(input.sources), input.conversationId, at, old.id);
        result = { note: this.readNote(input.scope, title)!, replaced: true };
      });
      return result;
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE scope = ?").get(input.scope) as { n: number }).n;
    if (count >= NOTE_LIMITS.perScope) {
      throw new Error(`There are already ${NOTE_LIMITS.perScope} notes here. Replace one by writing under its title, or tell the user to delete some.`);
    }
    const id = randomUUID();
    let result: { note: WorkNote; replaced: boolean } = null!;
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO notes (id, scope, conversation_id, title, title_key, text, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.scope, input.conversationId, title, titleKey, text, JSON.stringify(input.sources), at, at);
      result = { note: this.readNote(input.scope, title)!, replaced: false };
    });
    return result;
  }

  readNote(scope: string, title: string): WorkNote | null {
    const titleKey = title.replace(/\s+/g, " ").trim().normalize("NFC").toLowerCase();
    const row = this.db.prepare("SELECT * FROM notes WHERE scope = ? AND title_key = ?").get(scope, titleKey) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  searchNotes(scope: string, query: string, limit = SEARCH_HITS): WorkNote[] {
    const match = keywordQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare("SELECT n.* FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.scope = ? ORDER BY bm25(notes_fts) LIMIT ?")
      .all(match, scope, limit) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  /** Newest first. */
  listNotes(scope: string): WorkNote[] {
    const rows = this.db.prepare("SELECT * FROM notes WHERE scope = ? ORDER BY updated_at DESC, rowid DESC").all(scope) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  deleteNote(id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  /** A deleted conversation: its outputs and its own notes. What it wrote into its project stays there. */
  forgetConversation(conversationId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM outputs WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM output_counters WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM notes WHERE scope = ?").run(conversationScope(conversationId));
    });
  }

  /** "Forget everything": every output and note, and the file forgets them too. */
  clear(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM outputs;");
      this.db.exec("DELETE FROM output_counters;");
      this.db.exec("DELETE FROM notes;");
      this.db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');");
    });
    this.db.exec("VACUUM;");
  }

  /** A forgotten project: all of its notes. */
  forgetProject(projectId: string): void {
    this.db.prepare("DELETE FROM notes WHERE scope = ?").run(projectScope(projectId));
  }
}

function toNote(row: NoteRow): WorkNote {
  let sources: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.sources);
    if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // An unreadable list reads as none.
  }
  return { id: row.id, scope: row.scope, conversationId: row.conversation_id, title: row.title, text: row.text, sources, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** The archive, or null when its file can't be opened: outputs then stay in memory and notes are not offered. */
export function openWorkStore(dir: string): WorkStore | null {
  try {
    return new WorkStore(dir);
  } catch (err) {
    console.error("[vunemi] work archive:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
