/**
 * The library: an index of the user's earlier conversations and meetings,
 * so the model can be told which ones bear on a request and open the one it
 * needs. One row per conversation or meeting, with its name, its date, one
 * line about it and the words to search. The conversations and meetings
 * themselves stay where they are; this is a copy to look things up in, and
 * it is rebuilt from them (see library.ts).
 *
 * In SQLite built into Electron, owner-only like the chat history.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ItemKind = "conversation" | "meeting";

/** What is indexed of a conversation or a meeting. */
export interface ItemInput {
  /** The conversation's or the meeting's own id. */
  id: string;
  kind: ItemKind;
  title: string;
  /** When it was last worked on (a conversation) or held (a meeting). */
  at: number;
  /** One line about it, for the index the model is shown. */
  line: string;
  /** The words to search. */
  text: string;
  /** What the source said its version was when this was read: unchanged, it is not read again. */
  stamp: number;
}

export interface Item extends ItemInput {
  /**
   * What the model calls it: "c12", "m3". Short, since a small model copies
   * a long id wrong, and never given to another item, since an old
   * conversation may still name it.
   */
  ref: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'meeting')),
  title TEXT NOT NULL,
  at INTEGER NOT NULL,
  line TEXT NOT NULL,
  text TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  vector BLOB,
  vector_model TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, text, content='items', content_rowid='n', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, text) VALUES (new.n, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES ('delete', old.n, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, text ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES ('delete', old.n, old.title, old.text);
  INSERT INTO items_fts(rowid, title, text) VALUES (new.n, new.title, new.text);
END;
PRAGMA user_version = 1;
`;

interface Row {
  n: number;
  id: string;
  kind: ItemKind;
  title: string;
  at: number;
  line: string;
  text: string;
  stamp: number;
}

const REF = /^([cm])(\d{1,9})$/;

/** A word in more titles than this picks none of them out. */
const TITLE_FEW = 2;

export class LibraryStore {
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "library.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    // What is taken out of the library is overwritten on disk, not just unlinked.
    this.db.exec("PRAGMA secure_delete = ON;");
    this.db.exec(SCHEMA);
  }

  /** Adds an item or brings it up to date. Its ref stays, and its vector goes when its words changed. */
  upsert(input: ItemInput): void {
    const old = this.db.prepare("SELECT title, text, line FROM items WHERE id = ?").get(input.id) as { title: string; text: string; line: string } | undefined;
    if (!old) {
      this.db.prepare("INSERT INTO items (id, kind, title, at, line, text, stamp) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.id, input.kind, input.title, input.at, input.line, input.text, input.stamp);
      return;
    }
    const same = old.title === input.title && old.text === input.text && old.line === input.line;
    this.db.prepare(`UPDATE items SET title = ?, at = ?, line = ?, text = ?, stamp = ?${same ? "" : ", vector = NULL, vector_model = NULL"} WHERE id = ?`)
      .run(input.title, input.at, input.line, input.text, input.stamp, input.id);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }

  /** Every item's id and the version of its source it was read at. */
  stamps(): Map<string, number> {
    const rows = this.db.prepare("SELECT id, stamp FROM items").all() as { id: string; stamp: number }[];
    return new Map(rows.map((row) => [row.id, row.stamp]));
  }

  get(id: string): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? item(row) : null;
  }

  /** The item the model named, or null: nothing but a ref of our own shape is looked up. */
  byRef(ref: string): Item | null {
    const found = REF.exec(ref.trim().toLowerCase());
    if (!found) return null;
    const row = this.db.prepare("SELECT * FROM items WHERE n = ? AND kind = ?").get(Number(found[2]), found[1] === "c" ? "conversation" : "meeting") as Row | undefined;
    return row ? item(row) : null;
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n;
  }

  /**
   * Items a request is about, by its telling words: best first (BM25; a word in the title counts for more), each with
   * how many of those words it has and whether the request names it by its
   * title. A word that half the library has ("today", "nasıl") tells nothing
   * and is left out; so are words shorter than `minLetters`. A title is
   * named when the request has more than half of its words: one word of
   * "Camping tent" is not the tent. A word in the titles of more than
   * TITLE_FEW items ("meeting", "toplantısı") names none of them.
   */
  telling(request: string, limit: number, minLetters: number): { id: string; words: number; of: number; inTitle: boolean; score: number }[] {
    const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const stems = [...new Set((request.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => [...word].length >= minLetters).map((word) => [...word].slice(0, 5).join("")))].slice(0, 20);
    const total = this.count();
    const held = this.db.prepare("SELECT count(*) AS n FROM items_fts WHERE items_fts MATCH ?");
    const rare = stems.filter((stem) => total < 6 || (held.get(`"${stem}"*`) as { n: number }).n <= Math.max(1, Math.floor(total / 2)));
    if (rare.length === 0) return [];
    const rows = this.db.prepare(
      "SELECT i.id AS id, i.title AS title, i.text AS text, -bm25(items_fts, 4.0, 1.0) AS score FROM items_fts JOIN items i ON i.n = items_fts.rowid WHERE items_fts MATCH ? ORDER BY bm25(items_fts, 4.0, 1.0) LIMIT ?",
    ).all(rare.map((stem) => `"${stem}"*`).join(" OR "), limit) as { id: string; title: string; text: string; score: number }[];
    const starts = rare.map((stem) => new RegExp(`(?<![\\p{L}\\p{N}])${fold(stem)}`, "u"));
    const titles = new Map<string, boolean>();
    /** Whether few titles have a word that begins so. */
    const names = (stem: string): boolean => {
      if (!titles.has(stem)) titles.set(stem, (held.get(`title : "${stem}"*`) as { n: number }).n <= TITLE_FEW);
      return titles.get(stem)!;
    };
    const naming = rare.map(names);
    return rows.map((row) => {
      const title = fold(row.title);
      const text = fold(row.text);
      // The title's own words: not the short ones, and not those many titles share.
      const titleWords = title.match(/[\p{L}\p{N}]+/gu) ?? [];
      const own = titleWords.filter((word) => [...word].length >= minLetters && names([...word].slice(0, 5).join("")));
      const named = (own.length > 0 ? own : titleWords).map((word) => starts.some((re, i) => naming[i] && re.test(word)));
      return { id: row.id, words: starts.filter((re) => re.test(title) || re.test(text)).length, of: rare.length, inTitle: named.filter(Boolean).length * 2 > named.length, score: row.score };
    });
  }

  /** The newest items, for a search that names nothing. */
  recent(limit: number): Item[] {
    return (this.db.prepare("SELECT * FROM items ORDER BY at DESC LIMIT ?").all(limit) as unknown as Row[]).map(item);
  }

  vectors(model: string): { id: string; vector: Float32Array }[] {
    const rows = this.db.prepare("SELECT id, vector FROM items WHERE vector_model = ? AND vector IS NOT NULL").all(model) as { id: string; vector: Uint8Array }[];
    return rows.map((row) => ({ id: row.id, vector: new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)) }));
  }

  missingVectors(model: string, limit: number): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE vector IS NULL OR vector_model IS NOT ? ORDER BY at DESC LIMIT ?").all(model, limit) as unknown as Row[]).map(item);
  }

  setVector(id: string, model: string, vector: Float32Array): void {
    this.db.prepare("UPDATE items SET vector = ?, vector_model = ? WHERE id = ?").run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
  }

  /** Empties the library; the conversations and meetings are untouched. */
  clear(): void {
    this.db.exec("DELETE FROM items;");
    this.db.exec("INSERT INTO items_fts(items_fts) VALUES ('rebuild');");
    this.db.exec("VACUUM;");
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function item(row: Row): Item {
  return { ref: `${row.kind === "conversation" ? "c" : "m"}${row.n}`, id: row.id, kind: row.kind, title: row.title, at: row.at, line: row.line, text: row.text, stamp: row.stamp };
}
