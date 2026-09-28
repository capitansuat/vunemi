import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { t } from "@vunemi/i18n";
import { maskSecrets } from "@vunemi/agent-core";

export type NoteKind = "general" | "topic";

/** The user's own words a note came from. `sessionId` is null for notes moved from Preferences. */
export interface Evidence {
  quote: string;
  sessionId: string | null;
  at: number;
}

export interface Note {
  id: string;
  text: string;
  kind: NoteKind;
  createdAt: number;
  updatedAt: number;
  givenAt: number | null;
  confirmed: number;
  evidence: Evidence[];
}

const MAX_NOTES = 500;
const MAX_CHARS = 300;
const MAX_EVIDENCE = 5;
const MAX_QUOTE = 500;
const MAX_QUERY_WORDS = 20;
// Turkish (and most European languages) add suffixes; the first five letters
// are a good stem for search ("F5" stemming). Shorter words stay whole.
const STEM = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'topic')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  given_at INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 1,
  vector BLOB,
  vector_model TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  session_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_note ON evidence(note_id);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  text, content='notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
PRAGMA user_version = 1;
`;

interface NoteRow {
  id: string;
  text: string;
  kind: NoteKind;
  created_at: number;
  updated_at: number;
  given_at: number | null;
  confirmed: number;
}

/**
 * What Vunemi remembers about the user, in SQLite built into Electron. Every
 * note keeps the user's own words it came from. Protected like the chat
 * history: owner-only file permissions and FileVault, no Keychain prompt.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  /** Notes the Vault now recognises as holding a secret: listed, never searched or given. */
  private readonly withheld = new Set<string>();

  /** `redact` is the Vault's: it masks any stored secret, and may answer later. */
  constructor(private readonly dir: string, private readonly redact: (text: string) => string | Promise<string> = (text) => text) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "memory.db");
    const fresh = !existsSync(file);
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    // A forgotten note is overwritten on disk, not just unlinked.
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    this.db.exec(SCHEMA);
    if (fresh) this.moveInPreferences();
  }

  /** Checks saved notes against the Vault, once it can answer. */
  async check(): Promise<void> {
    for (const note of this.rows("SELECT * FROM notes")) {
      let masked: string;
      try { masked = await this.redact(note.text); } catch { return; }
      if (masked !== note.text) this.withheld.add(note.id);
    }
  }

  list(): Note[] {
    return this.rows("SELECT * FROM notes ORDER BY created_at, rowid").map((row) => this.note(row));
  }

  get(id: string): Note | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
    return row ? this.note(row) : null;
  }

  async validText(input: unknown): Promise<string> {
    if (typeof input !== "string") throw new Error(t("memory.invalid"));
    const text = input.trim();
    if (!text || text.length > MAX_CHARS || /[\r\n\u0000-\u001f]/u.test(text)) throw new Error(t("memory.invalid"));
    if (await this.holdsSecret(text)) throw new Error(t("memory.secret"));
    return text;
  }

  /** A password-like pattern, or something stored in the Vault. */
  async holdsSecret(text: string): Promise<boolean> {
    return maskSecrets(text) !== text || (await this.redact(text)) !== text;
  }

  async add(input: { text: string; kind: NoteKind; evidence: Evidence }): Promise<Note> {
    const text = await this.validText(input.text);
    if (input.kind !== "general" && input.kind !== "topic") throw new Error(t("memory.invalid"));
    const count = (this.db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
    if (count >= MAX_NOTES) throw new Error(t("memory.full"));
    const id = randomUUID();
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare("INSERT INTO notes (id, text, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, text, input.kind, now, now);
      this.addEvidence(id, input.evidence);
    });
    return this.get(id)!;
  }

  /** The user said it again: one more confirmation, and the words kept as evidence. */
  confirm(id: string, evidence: Evidence): Note {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE notes SET confirmed = confirmed + 1, updated_at = ? WHERE id = ?").run(Date.now(), id).changes;
      if (!changed) throw new Error(t("memory.invalid"));
      this.addEvidence(id, evidence);
    });
    return this.get(id)!;
  }

  async update(id: string, input: string, evidence?: Evidence): Promise<Note> {
    const text = await this.validText(input);
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE notes SET text = ?, updated_at = ?, vector = NULL, vector_model = NULL WHERE id = ?").run(text, Date.now(), id).changes;
      if (!changed) throw new Error(t("memory.invalid"));
      if (evidence) this.addEvidence(id, evidence);
    });
    this.withheld.delete(id);
    return this.get(id)!;
  }

  remove(id: string): boolean {
    this.withheld.delete(id);
    return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
  }

  clear(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM notes;");
      this.db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');");
    });
    this.db.exec("VACUUM;");
    this.withheld.clear();
  }

  /** Notes sharing words with the request, best first (BM25). */
  keyword(request: string, limit: number): { id: string; rank: number }[] {
    const query = keywordQuery(request);
    if (!query) return [];
    const rows = this.db.prepare(
      "SELECT n.id AS id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?",
    ).all(query, limit + this.withheld.size) as { id: string }[];
    return rows.filter((row) => !this.withheld.has(row.id)).slice(0, limit).map((row, i) => ({ id: row.id, rank: i + 1 }));
  }

  /** How the user wants to work with Vunemi: most confirmed first, then most recent. */
  general(limit: number): Note[] {
    return this.rows("SELECT * FROM notes WHERE kind = 'general' ORDER BY confirmed DESC, updated_at DESC, rowid DESC")
      .filter((row) => !this.withheld.has(row.id)).slice(0, limit).map((row) => this.note(row));
  }

  vectors(model: string): { id: string; vector: Float32Array }[] {
    const rows = this.db.prepare("SELECT id, vector FROM notes WHERE vector_model = ? AND vector IS NOT NULL").all(model) as { id: string; vector: Uint8Array }[];
    return rows.filter((row) => !this.withheld.has(row.id)).map((row) => ({ id: row.id, vector: toVector(row.vector) }));
  }

  setVector(id: string, model: string, vector: Float32Array): void {
    this.db.prepare("UPDATE notes SET vector = ?, vector_model = ? WHERE id = ?").run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
  }

  missingVectors(model: string): Note[] {
    return this.rows("SELECT * FROM notes WHERE vector IS NULL OR vector_model IS NOT ?", model)
      .filter((row) => !this.withheld.has(row.id)).map((row) => this.note(row));
  }

  markGiven(ids: string[], at = Date.now()): void {
    const stmt = this.db.prepare("UPDATE notes SET given_at = ? WHERE id = ?");
    this.transaction(() => { for (const id of ids) stmt.run(at, id); });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private addEvidence(id: string, evidence: Evidence): void {
    const quote = evidence.quote.trim().slice(0, MAX_QUOTE);
    this.db.prepare("INSERT INTO evidence (note_id, quote, session_id, at) VALUES (?, ?, ?, ?)").run(id, quote, evidence.sessionId, evidence.at);
    this.db.prepare(
      "DELETE FROM evidence WHERE note_id = ? AND rowid NOT IN (SELECT rowid FROM evidence WHERE note_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)",
    ).run(id, id, MAX_EVIDENCE);
  }

  private rows(sql: string, ...params: (string | number | null)[]): NoteRow[] {
    return this.db.prepare(sql).all(...params) as unknown as NoteRow[];
  }

  private note(row: NoteRow): Note {
    const evidence = this.db.prepare("SELECT quote, session_id, at FROM evidence WHERE note_id = ? ORDER BY at, rowid").all(row.id) as { quote: string; session_id: string | null; at: number }[];
    return {
      id: row.id,
      text: row.text,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      givenAt: row.given_at,
      confirmed: row.confirmed,
      evidence: evidence.map((e) => ({ quote: e.quote, sessionId: e.session_id, at: e.at })),
    };
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

  /** Preferences, the older list, become general notes; the file is kept as .bak. */
  private moveInPreferences(): void {
    const file = join(this.dir, "preferences.json");
    if (!existsSync(file)) return;
    let items: { text: string; createdAt: number }[];
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(value) || value.length > 30) return;
      items = value.filter((item): item is { text: string; createdAt: number } =>
        !!item && typeof item.text === "string" && typeof item.createdAt === "number"
        && item.text.trim().length > 0 && item.text.length <= MAX_CHARS && !/[\r\n\u0000-\u001f]/u.test(item.text)
        && maskSecrets(item.text) === item.text);
    } catch {
      return;
    }
    const insert = this.db.prepare("INSERT INTO notes (id, text, kind, created_at, updated_at) VALUES (?, ?, 'general', ?, ?)");
    this.transaction(() => {
      for (const item of items) {
        const id = randomUUID();
        insert.run(id, item.text.trim(), item.createdAt, item.createdAt);
        this.addEvidence(id, { quote: item.text.trim(), sessionId: null, at: item.createdAt });
      }
    });
    renameSync(file, `${file}.bak`);
  }
}

/**
 * The request as an FTS5 query: each word as a quoted prefix, joined by OR.
 * Only letters and digits reach the query, so nothing in a request can be
 * read as FTS syntax.
 */
export function keywordQuery(request: string): string {
  const words = request.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const stems = [...new Set(words.map((word) => [...word].slice(0, STEM).join("")))];
  return stems.slice(0, MAX_QUERY_WORDS).map((stem) => `"${stem}"*`).join(" OR ");
}

function toVector(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
