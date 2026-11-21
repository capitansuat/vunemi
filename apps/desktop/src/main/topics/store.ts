/**
 * Topic memory: what Vunemi keeps about a subject the user chose, as plain
 * Markdown in a folder of their Documents (tenami/docs/superpowers/specs/
 * 2026-11-21-topic-memory-design.md).
 *
 *   <root>/<Topic>/topic.md          what the topic is about
 *   <root>/<Topic>/Notes/<Title>.md  what Vunemi (or the user) wrote down
 *   <root>/<Topic>/Sources/<name>.md a file the user gave, as Markdown
 *
 * The files are the record. A note edited in Obsidian is what Vunemi reads
 * next; this keeps only an index of them (topics.db), brought up to date from
 * the files' sizes and times whenever it is used.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keywordQuery } from "../memory/store.js";

export const TOPIC_LIMITS = { name: 80, title: 80, text: 4_000, notes: 500, sources: 200, sourceChars: 2_000_000, about: 1_000 } as const;
const NOTES = "Notes";
const SOURCES = "Sources";
const ABOUT = "topic.md";
const SEARCH_HITS = 10;
const BACKUPS_KEPT = 50;

export type NoteAuthor = "vunemi" | "user";

export interface Topic {
  name: string;
  about: string;
  dir: string;
  notes: number;
  sources: number;
  /** Newest change to any of its files, ms. */
  updatedAt: number;
}

export interface TopicNote {
  topic: string;
  title: string;
  text: string;
  by: NoteAuthor;
  /** Where it came from: source names, or "conversation: <title>, <date>". */
  sources: string[];
  created: string;
  updated: string;
  path: string;
  /** Titles it links to with [[…]]. */
  links: string[];
}

export interface TopicSource {
  topic: string;
  name: string;
  path: string;
  /** The file it was made from, as it was when added. */
  original: string;
  bytes: number;
  sha256: string;
  added: string;
  chars: number;
}

export interface TopicHit {
  kind: "note" | "source";
  topic: string;
  title: string;
  snippet: string;
  path: string;
  /** Where in the note or source the hit is, in characters, when known. */
  at?: number;
}

/** A name for a folder or file that every Mac app, Obsidian and a Windows disk accept. */
export function cleanName(value: unknown, what: "topic" | "title"): string {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().normalize("NFC");
  const max = what === "topic" ? TOPIC_LIMITS.name : TOPIC_LIMITS.title;
  if (!name || [...name].length > max) throw new Error(`A ${what === "topic" ? "topic name" : "note title"} needs 1–${max} characters.`);
  if (/[\u0000-\u001f\u007f/\\:*?"<>|[\]#^]/.test(name) || name.startsWith(".") || name.endsWith(".")) {
    throw new Error(`A ${what === "topic" ? "topic name" : "note title"} can't contain / \\ : * ? " < > | [ ] # ^ or start or end with a dot.`);
  }
  return name;
}

/** Any case, in Turkish and English alike: İzmir, izmir and IZMIR are one name; so are ı and i. */
const keyOf = (name: string): string => name.normalize("NFC").toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/̇/g, "").normalize("NFC");

// -- Markdown with front matter ------------------------------------------------

/** Front matter as Obsidian writes it: `key: value`, values here written as JSON, which YAML reads. */
export function parseNote(file: string): { meta: Record<string, unknown>; body: string } {
  const text = file.replace(/^﻿/, "");
  const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!head) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of head[1]!.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2]!.trim();
    try {
      meta[m[1]!] = JSON.parse(raw);
    } catch {
      meta[m[1]!] = raw.replace(/^'(.*)'$/, "$1");
    }
  }
  return { meta, body: text.slice(head[0].length) };
}

export function writeFront(meta: Record<string, unknown>, body: string): string {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** The titles a note links to: [[Title]], [[Title|shown]], [[Title#part]]. */
export function linksIn(body: string): string[] {
  const found = new Map<string, string>();
  for (const m of body.matchAll(/\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const title = m[1]!.trim();
    if (title) found.set(keyOf(title), title);
  }
  return [...found.values()];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

// -- the index ------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'source')),
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS files_topic ON files(topic_key, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title, body, content='files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO files_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  start INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector BLOB,
  vector_model TEXT
);
CREATE INDEX IF NOT EXISTS parts_path ON parts(path);
`;
/** Version 2 added parts: an index from before has none, so it is made again from the files. */
const INDEX_VERSION = 2;

/** A part of a note or source, embedded on its own: about this long. */
export const PART_CHARS = 1_000;

/**
 * A text cut into parts for search by meaning: paragraphs together up to
 * PART_CHARS, a longer paragraph by its lines, a longer line by length. A
 * table cut in several keeps its header row in each, so a row still says
 * what its columns are. `start` is where the part begins in the text.
 */
export function partsOf(text: string, max = PART_CHARS): { start: number; text: string }[] {
  const pieces: { start: number; text: string }[] = [];
  const blocks = [...text.matchAll(/[^\n]+(?:\n[^\n]+)*/g)].map((m) => ({ start: m.index!, text: m[0] }));
  for (const block of blocks) {
    if (block.text.length <= max) {
      pieces.push(block);
      continue;
    }
    const lines = [...block.text.matchAll(/[^\n]+/g)].flatMap((m) => {
      // A line longer than a part is cut by length.
      const cut: { start: number; text: string }[] = [];
      for (let at = 0; at < m[0].length; at += max) cut.push({ start: block.start + m.index! + at, text: m[0].slice(at, at + max) });
      return cut;
    });
    const table = lines.length > 2 && lines.every((l) => l.text.trimStart().startsWith("|"));
    const head = table && lines[0]!.text.length + lines[1]!.text.length < max / 2 ? `${lines[0]!.text}\n${lines[1]!.text}\n` : "";
    let group: { start: number; text: string } | null = null;
    for (const line of head ? lines.slice(2) : lines) {
      if (group && group.text.length + 1 + line.text.length <= max) group.text += `\n${line.text}`;
      else {
        if (group) pieces.push(group);
        // The first part starts where the block does, header and all.
        group = { start: group === null ? block.start : line.start, text: head + line.text };
      }
    }
    if (group) pieces.push(group);
  }
  // Short paragraphs side by side make one part.
  const parts: { start: number; text: string }[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last && last.text.length + 2 + piece.text.length <= max) last.text += `\n\n${piece.text}`;
    else parts.push({ ...piece });
  }
  return parts.filter((p) => p.text.trim());
}

interface Row {
  path: string;
  topic_key: string;
  kind: "note" | "source";
  title: string;
  title_key: string;
  body: string;
  size: number;
  mtime: number;
}

export interface TopicStoreOptions {
  /** The topics folder, in Documents. Made when the first topic is. */
  root: () => string;
  /** Vunemi's own data folder, for the index and replaced notes. */
  dataDir: string;
  now?: () => number;
}

export class TopicStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly backups: string;

  constructor(private readonly opts: TopicStoreOptions) {
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.dataDir, { recursive: true });
    const file = join(opts.dataDir, "topics.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec("PRAGMA secure_delete = ON;");
    this.db.exec(SCHEMA);
    if ((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < INDEX_VERSION) {
      this.db.exec(`DELETE FROM files; DELETE FROM parts; PRAGMA user_version = ${INDEX_VERSION};`);
    }
    this.backups = join(opts.dataDir, "topic-backups");
  }

  close(): void {
    this.db.close();
  }

  get root(): string {
    return this.opts.root();
  }

  // -- topics -------------------------------------------------------------------

  /** Every folder in the topics folder is a topic, made by Vunemi or not. Newest first. */
  listTopics(): Topic[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => this.topicAt(d.name))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The topic of this name, any case. */
  findTopic(name: string): Topic | null {
    const key = keyOf(String(name ?? "").replace(/\s+/g, " ").trim());
    const hit = existsSync(this.root) ? readdirSync(this.root, { withFileTypes: true }).find((d) => d.isDirectory() && !d.name.startsWith(".") && keyOf(d.name) === key) : undefined;
    return hit ? this.topicAt(hit.name) : null;
  }

  createTopic(nameIn: string, aboutIn: string): Topic {
    const name = cleanName(nameIn, "topic");
    if (this.findTopic(name)) throw new Error(`There is already a topic called "${name}".`);
    const about = String(aboutIn ?? "").trim().slice(0, TOPIC_LIMITS.about);
    const dir = join(this.root, name);
    mkdirSync(join(dir, NOTES), { recursive: true });
    mkdirSync(join(dir, SOURCES), { recursive: true });
    this.inside(dir);
    writeFileSync(join(dir, ABOUT), writeFront({ topic: name, created: new Date(this.now()).toISOString() }, about || name));
    return this.topicAt(name);
  }

  setAbout(topicName: string, aboutIn: string): Topic {
    const topic = this.need(topicName);
    const file = join(topic.dir, ABOUT);
    const old = existsSync(file) ? parseNote(readFileSync(file, "utf8")).meta : {};
    atomicWrite(file, writeFront({ topic: topic.name, created: old.created ?? new Date(this.now()).toISOString() }, String(aboutIn ?? "").trim().slice(0, TOPIC_LIMITS.about) || topic.name));
    return this.topicAt(topic.name);
  }

  private topicAt(name: string): Topic {
    const dir = join(this.root, name);
    const aboutFile = join(dir, ABOUT);
    const about = existsSync(aboutFile) ? parseNote(readFileSync(aboutFile, "utf8")).body.trim() : "";
    const count = (sub: string) => (existsSync(join(dir, sub)) ? mdFiles(join(dir, sub)) : []);
    const notes = count(NOTES);
    const sources = count(SOURCES);
    const times = [...notes, ...sources, ...(existsSync(aboutFile) ? [aboutFile] : [])].map((p) => statSync(p).mtimeMs);
    return { name, about, dir, notes: notes.length, sources: sources.length, updatedAt: times.length ? Math.max(...times) : statSync(dir).mtimeMs };
  }

  private need(topicName: string): Topic {
    const topic = this.findTopic(topicName);
    if (!topic) throw new Error(`No topic called "${topicName}".`);
    return topic;
  }

  /** Writes stay in the topics folder, whatever a link inside it points to. */
  private inside(path: string): void {
    const root = realpathSync(this.root);
    const real = realpathSync(path);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("That topic folder leads outside the topics folder; nothing was written.");
  }

  // -- the index, from the files ---------------------------------------------------

  /** Brings the index up to date with one topic's files: new, changed and gone. */
  private sync(topic: Topic): void {
    const topicKey = keyOf(topic.name);
    const known = new Map((this.db.prepare("SELECT path, size, mtime FROM files WHERE topic_key = ?").all(topicKey) as unknown as Pick<Row, "path" | "size" | "mtime">[]).map((r) => [r.path, r]));
    const seen = new Set<string>();
    this.db.exec("BEGIN");
    try {
      for (const [sub, kind] of [[NOTES, "note"], [SOURCES, "source"]] as const) {
        const dir = join(topic.dir, sub);
        if (!existsSync(dir)) continue;
        for (const path of mdFiles(dir)) {
          seen.add(path);
          const st = statSync(path);
          const was = known.get(path);
          if (was && was.size === st.size && was.mtime === st.mtimeMs) continue;
          const { meta, body } = parseNote(readFileSync(path, "utf8"));
          const title = kind === "note" && typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : basename(path, ".md");
          this.db
            .prepare("INSERT INTO files (path, topic_key, kind, title, title_key, body, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET topic_key = excluded.topic_key, kind = excluded.kind, title = excluded.title, title_key = excluded.title_key, body = excluded.body, size = excluded.size, mtime = excluded.mtime")
            .run(path, topicKey, kind, title, keyOf(title), body, st.size, st.mtimeMs);
          // New words, new parts: their vectors are made again (TopicMeaning.catchUp).
          this.db.prepare("DELETE FROM parts WHERE path = ?").run(path);
          const insert = this.db.prepare("INSERT INTO parts (path, start, text) VALUES (?, ?, ?)");
          for (const part of partsOf(body)) insert.run(path, part.start, part.text);
        }
      }
      for (const path of known.keys()) {
        if (seen.has(path)) continue;
        this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
        this.db.prepare("DELETE FROM parts WHERE path = ?").run(path);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // -- notes ----------------------------------------------------------------------

  /** Newest first. */
  listNotes(topicName: string): TopicNote[] {
    const topic = this.need(topicName);
    return mdFiles(join(topic.dir, NOTES))
      .map((path) => this.noteAt(topic.name, path))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  readNote(topicName: string, title: string): TopicNote | null {
    const topic = this.need(topicName);
    const path = this.notePath(topic, title);
    return path ? this.noteAt(topic.name, path) : null;
  }

  /** The notes of this topic that link to this one. */
  backlinks(topicName: string, title: string): string[] {
    const key = keyOf(title);
    return this.listNotes(topicName).filter((n) => keyOf(n.title) !== key && n.links.some((l) => keyOf(l) === key)).map((n) => n.title);
  }

  /**
   * Writes a note under its title, replacing one of the same title. What it
   * replaced is kept in Vunemi's data folder and returned, for undo.
   */
  writeNote(topicName: string, input: { title: string; text: string; by: NoteAuthor; sources: string[] }): { note: TopicNote; replaced: boolean; previous: string | null } {
    const topic = this.need(topicName);
    const title = cleanName(input.title, "title");
    const text = String(input.text ?? "").trim();
    if (!text) throw new Error("A note needs some text.");
    if (text.length > TOPIC_LIMITS.text) throw new Error(`A note may hold at most ${TOPIC_LIMITS.text.toLocaleString("en-GB")} characters; shorten it or split it under two titles.`);
    mkdirSync(join(topic.dir, NOTES), { recursive: true });
    this.inside(join(topic.dir, NOTES));
    const existing = this.notePath(topic, title);
    if (!existing && mdFiles(join(topic.dir, NOTES)).length >= TOPIC_LIMITS.notes) {
      throw new Error(`"${topic.name}" already has ${TOPIC_LIMITS.notes} notes. Replace one by writing under its title, or tell the user to delete some.`);
    }
    const at = new Date(this.now()).toISOString();
    const previous = existing ? readFileSync(existing, "utf8") : null;
    const created = previous ? parseNote(previous).meta.created : undefined;
    const path = existing ?? join(topic.dir, NOTES, `${title}.md`);
    if (previous) this.keep(topic.name, title, previous);
    atomicWrite(path, writeFront({ title, created: typeof created === "string" ? created : at, updated: at, by: input.by, sources: input.sources }, text));
    return { note: this.noteAt(topic.name, path), replaced: previous !== null, previous };
  }

  /** Puts a note back as it was (undo): the old text, or no note when there was none. */
  restoreNote(topicName: string, title: string, previous: string | null, trash: (path: string) => void): void {
    const topic = this.need(topicName);
    const path = this.notePath(topic, title);
    if (previous === null) {
      if (path) trash(path);
      return;
    }
    atomicWrite(path ?? join(topic.dir, NOTES, `${cleanName(title, "title")}.md`), previous);
  }

  /** The file a note of this title is in, any case; null when there is none. */
  notePath(topic: Topic, title: string): string | null {
    this.sync(topic);
    const row = this.db.prepare("SELECT path FROM files WHERE topic_key = ? AND kind = 'note' AND title_key = ?").get(keyOf(topic.name), keyOf(String(title ?? "").replace(/\s+/g, " ").trim())) as { path: string } | undefined;
    return row && existsSync(row.path) ? row.path : null;
  }

  private noteAt(topic: string, path: string): TopicNote {
    const st = statSync(path);
    const { meta, body } = parseNote(readFileSync(path, "utf8"));
    const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : basename(path, ".md");
    const iso = (v: unknown, ms: number) => (typeof v === "string" && v ? v : new Date(ms).toISOString());
    return {
      topic,
      title,
      text: body.trim(),
      // A note without Vunemi's front matter was written by someone else: the user, in Obsidian say.
      by: meta.by === "vunemi" ? "vunemi" : "user",
      sources: strings(meta.sources),
      created: iso(meta.created, st.birthtimeMs || st.mtimeMs),
      updated: iso(meta.updated, st.mtimeMs),
      path,
      links: linksIn(body),
    };
  }

  private keep(topic: string, title: string, text: string): void {
    mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.backups, `${this.now()}-${randomUUID().slice(0, 8)}.md`), `<!-- ${JSON.stringify({ topic, title })} -->\n${text}`, { mode: 0o600 });
    const kept = readdirSync(this.backups).filter((f) => f.endsWith(".md")).sort();
    // Vunemi's own copies, not the user's notes: the oldest go once there are enough.
    for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) rmSync(join(this.backups, old), { force: true });
  }

  // -- sources ----------------------------------------------------------------------

  listSources(topicName: string): TopicSource[] {
    const topic = this.need(topicName);
    return mdFiles(join(topic.dir, SOURCES)).map((path) => sourceAt(topic.name, path)).sort((a, b) => b.added.localeCompare(a.added));
  }

  /** A file the user gave, as Markdown. The same file added again is the same source. */
  addSource(topicName: string, input: { original: string; markdown: string; bytes: number; sha256: string }): { source: TopicSource; added: boolean } {
    const topic = this.need(topicName);
    const dir = join(topic.dir, SOURCES);
    mkdirSync(dir, { recursive: true });
    this.inside(dir);
    const all = this.listSources(topic.name);
    const same = all.find((s) => s.sha256 === input.sha256);
    if (same) return { source: same, added: false };
    if (all.length >= TOPIC_LIMITS.sources) throw new Error(`"${topic.name}" already has ${TOPIC_LIMITS.sources} sources.`);
    const stem = safeFile(basename(input.original, extname(input.original)));
    const taken = new Set(all.map((s) => keyOf(s.name)));
    let name = stem;
    if (taken.has(keyOf(name))) name = safeFile(basename(input.original));
    for (let n = 2; taken.has(keyOf(name)); n++) name = `${stem} ${n}`;
    let markdown = input.markdown;
    if (markdown.length > TOPIC_LIMITS.sourceChars) {
      markdown = `${markdown.slice(0, TOPIC_LIMITS.sourceChars)}\n\n[Cut here: the file's text was longer than ${TOPIC_LIMITS.sourceChars.toLocaleString("en-GB")} characters.]`;
    }
    const path = join(dir, `${name}.md`);
    atomicWrite(path, writeFront({ original: input.original, bytes: input.bytes, sha256: input.sha256, added: new Date(this.now()).toISOString() }, markdown));
    return { source: sourceAt(topic.name, path), added: true };
  }

  readSource(topicName: string, name: string): { source: TopicSource; text: string } | null {
    const topic = this.need(topicName);
    const key = keyOf(String(name ?? "").trim().replace(/\.md$/i, ""));
    const path = mdFiles(join(topic.dir, SOURCES)).find((p) => keyOf(basename(p, ".md")) === key);
    return path ? { source: sourceAt(topic.name, path), text: parseNote(readFileSync(path, "utf8")).body } : null;
  }

  // -- search -------------------------------------------------------------------------

  /** Brings the index up to date with every topic's files. */
  refresh(): void {
    for (const topic of this.listTopics()) this.sync(topic);
  }

  /** Parts with no vector of this model yet, with the title of what they are part of. */
  missingParts(model: string, limit: number): { id: number; title: string; text: string }[] {
    return this.db
      .prepare("SELECT p.id, f.title, p.text FROM parts p JOIN files f ON f.path = p.path WHERE p.vector IS NULL OR p.vector_model IS NOT ? ORDER BY f.kind = 'source', p.id LIMIT ?")
      .all(model, limit) as unknown as { id: number; title: string; text: string }[];
  }

  /** How many parts still wait for a vector: in one topic, or all. */
  pendingParts(model: string, topicName?: string): number {
    const where = topicName ? "AND f.topic_key = ?" : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM parts p JOIN files f ON f.path = p.path WHERE (p.vector IS NULL OR p.vector_model IS NOT ?) ${where}`)
      .get(...(topicName ? [model, keyOf(topicName)] : [model])) as { n: number };
    return row.n;
  }

  /** Kept only while the part still holds the words it was made of. */
  setPartVector(id: number, text: string, model: string, vector: Float32Array): void {
    this.db.prepare("UPDATE parts SET vector = ?, vector_model = ? WHERE id = ? AND text = ?").run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id, text);
  }

  /** The parts nearest a query's vector, at most one per file, best first. */
  nearestParts(query: Float32Array, model: string, topicName: string | undefined, limit: number): (TopicHit & { score: number })[] {
    const topics = topicName ? [this.need(topicName)] : this.listTopics();
    const names = new Map(topics.map((t) => [keyOf(t.name), t.name]));
    const where = topicName ? "AND f.topic_key = ?" : "";
    const rows = this.db
      .prepare(`SELECT p.path, p.start, p.text, p.vector, f.kind, f.topic_key, f.title FROM parts p JOIN files f ON f.path = p.path WHERE p.vector_model = ? AND p.vector IS NOT NULL ${where}`)
      .iterate(...(topicName ? [model, keyOf(topicName)] : [model])) as Iterable<{ path: string; start: number; text: string; vector: Uint8Array; kind: "note" | "source"; topic_key: string; title: string }>;
    const best = new Map<string, TopicHit & { score: number }>();
    for (const row of rows) {
      const topic = names.get(row.topic_key);
      if (!topic) continue;
      const vector = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      let score = 0;
      if (vector.length === query.length) for (let i = 0; i < vector.length; i++) score += vector[i]! * query[i]!;
      const was = best.get(row.path);
      if (!was || score > was.score) best.set(row.path, { kind: row.kind, topic, title: row.title, snippet: row.text, path: row.path, at: row.start, score });
    }
    return [...best.values()].filter((hit) => existsSync(hit.path)).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Notes and sources whose words match, best first; one topic, or all of
   * them. `most`: only those holding at least half of the query's words, so
   * a "for" or "için" alone finds nothing (meaning.ts, beside meaning).
   */
  search(query: string, topicName?: string, limit = SEARCH_HITS, most = false): TopicHit[] {
    const match = keywordQuery(query);
    if (!match) return [];
    if (most) {
      const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");
      const stems = [...new Set(match.match(/"([^"]+)"/g)!.map((q) => fold(q.slice(1, -1))))];
      const starts = stems.map((stem) => new RegExp(`(?<![\\p{L}\\p{N}])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
      return this.search(query, topicName, limit * 3).filter((hit) => {
        const row = this.db.prepare("SELECT title, body FROM files WHERE path = ?").get(hit.path) as { title: string; body: string } | undefined;
        const text = row ? fold(`${row.title}\n${row.body}`) : "";
        return starts.filter((re) => re.test(text)).length * 2 >= stems.length;
      }).slice(0, limit);
    }
    const topics = topicName ? [this.need(topicName)] : this.listTopics();
    for (const topic of topics) this.sync(topic);
    const names = new Map(topics.map((t) => [keyOf(t.name), t.name]));
    const rows = this.db
      .prepare(`SELECT f.kind, f.topic_key, f.title, f.path, snippet(files_fts, 1, '', '', '…', 16) AS snip FROM files_fts JOIN files f ON f.rowid = files_fts.rowid WHERE files_fts MATCH ? ${topicName ? "AND f.topic_key = ?" : ""} ORDER BY bm25(files_fts) LIMIT ?`)
      .all(...(topicName ? [match, keyOf(topicName), limit] : [match, limit])) as unknown as { kind: "note" | "source"; topic_key: string; title: string; path: string; snip: string }[];
    return rows.filter((r) => names.has(r.topic_key) && existsSync(r.path)).map((r) => ({ kind: r.kind, topic: names.get(r.topic_key)!, title: r.title, snippet: r.snip.replace(/\s+/g, " ").trim(), path: r.path }));
  }
}

function sourceAt(topic: string, path: string): TopicSource {
  const { meta, body } = parseNote(readFileSync(path, "utf8"));
  const st = statSync(path);
  return {
    topic,
    name: basename(path, ".md"),
    path,
    original: typeof meta.original === "string" ? meta.original : "",
    bytes: typeof meta.bytes === "number" ? meta.bytes : 0,
    sha256: typeof meta.sha256 === "string" ? meta.sha256 : "",
    added: typeof meta.added === "string" ? meta.added : new Date(st.mtimeMs).toISOString(),
    chars: body.length,
  };
}

/** The Markdown files directly in a folder, not in hidden ones or below. */
function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith(".") && d.name.toLowerCase().endsWith(".md"))
    .map((d) => join(dir, d.name));
}

/** A file name from another file's: the characters a name can't hold become a dash. */
function safeFile(name: string): string {
  const clean = name.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:*?"<>|[\]#^]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  return [...(clean || "source")].slice(0, TOPIC_LIMITS.title).join("");
}

/** Written whole or not at all: Obsidian or a sync tool reading it never sees half a note. */
function atomicWrite(path: string, text: string): void {
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, path);
}

export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The store, or null when its index can't be opened: topics are then not offered. */
export function openTopicStore(opts: TopicStoreOptions): TopicStore | null {
  try {
    return new TopicStore(opts);
  } catch (err) {
    console.error("[vunemi] topics:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
