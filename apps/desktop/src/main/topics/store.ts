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
import { basename, dirname, extname, join, posix, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keywordQuery } from "../memory/store.js";
import { codesOf, linksOf, outlineOf, resolveLink } from "./skeleton.js";

/** How long a write waits for another program reading the index. */
const BUSY_WAIT_MS = 1_000;

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
  /** Other names of what the page is about: "loan rule", codes such as QXA. */
  aliases: string[];
  /** The files it was written from: a linked file or a source by name, the heading, its SHA-256 then. */
  cites: TopicCite[];
}

export interface TopicCite {
  file: string;
  heading?: string;
  sha256: string;
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
  /** A file is in a folder linked to the topic, read where it is (topics/linked.ts). */
  kind: "note" | "source" | "file";
  topic: string;
  title: string;
  snippet: string;
  path: string;
  /** Where in the note or source the hit is, in characters, when known. */
  at?: number;
  /** A file's linked folder, and its path inside it. */
  folder?: string;
  rel?: string;
}

/**
 * A folder linked to a topic: its files are searched and read where they
 * are, never copied (tenami/docs/superpowers/specs/2026-11-22-topic-wiki-design.md).
 * `meaning`: a top-level subfolder's search by meaning, where the user set it.
 */
export interface LinkedFolder {
  path: string;
  meaning: Record<string, boolean>;
}

/** A linked file as the index has it. */
export interface LinkedRow {
  path: string;
  rel: string;
  folder: string;
  size: number;
  mtime: number;
  sha256: string;
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
export const keyOf = (name: string): string => name.normalize("NFC").toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/̇/g, "").normalize("NFC");

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

/** Citations as front matter holds them; anything else there is left out. */
const citesOf = (value: unknown): TopicCite[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        if (!v || typeof v !== "object") return [];
        const { file, heading, sha256 } = v as Record<string, unknown>;
        if (typeof file !== "string" || !file || typeof sha256 !== "string") return [];
        return [{ file, ...(typeof heading === "string" && heading ? { heading } : {}), sha256 }];
      })
    : [];

// -- the index ------------------------------------------------------------------

const FILES_TABLE = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  path TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'source', 'linked')),
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  folder TEXT,
  rel TEXT,
  sha256 TEXT,
  original TEXT,
  outline TEXT
);`;
const SCHEMA = `
${FILES_TABLE("files")}
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
-- A linked file's links as written, inside its folder: resolved when read,
-- so a link to a file indexed later still leads to it.
CREATE TABLE IF NOT EXISTS links (
  topic_key TEXT NOT NULL,
  folder TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  dst_stem TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE INDEX IF NOT EXISTS links_dst ON links(folder, dst_stem);
-- By the file's rowid, not its path: a large folder has some 200,000 of
-- these, and a path in each would add tens of megabytes to the index.
CREATE TABLE IF NOT EXISTS codes (
  file INTEGER NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL,
  defined INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_code ON codes(code);
CREATE INDEX IF NOT EXISTS codes_file ON codes(file);
`;
/**
 * Version 2 added parts: an index from before has none, so it is made again
 * from the files. Version 3 added linked files; one of version 2 is moved
 * over with its vectors, which took an hour to make for 200 sources.
 */
const INDEX_VERSION = 3;

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
  kind: "note" | "source" | "linked";
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
  /** After Vunemi changed a topic's files: the Memory page shows them again. */
  onChange?: () => void;
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
    /*
     * Another program reading the index (a backup, a database viewer) held
     * it long enough for a write to fail at once: "database is locked". A
     * write waits a moment instead. It waits on the main thread, so briefly.
     */
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_WAIT_MS};`);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === 2) this.fromVersion2();
    else if (version < 2) this.db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS files_fts; DROP TABLE IF EXISTS parts;");
    this.db.exec(SCHEMA);
    // A version 3 index from before outlines were kept.
    if (!(this.db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).some((c) => c.name === "outline")) this.db.exec("ALTER TABLE files ADD COLUMN outline TEXT");
    if (version < INDEX_VERSION) {
      this.db.exec(`INSERT INTO files_fts(files_fts) VALUES('rebuild'); PRAGMA user_version = ${INDEX_VERSION};`);
      if (version === 2) this.originals();
    }
    this.backups = join(opts.dataDir, "topic-backups");
  }

  close(): void {
    this.db.close();
  }

  /** Version 2's notes and sources into version 3's table, rows and parts kept. */
  private fromVersion2(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec(FILES_TABLE("files_v3"));
      this.db.exec("INSERT INTO files_v3 (rowid, path, topic_key, kind, title, title_key, body, size, mtime) SELECT rowid, path, topic_key, kind, title, title_key, body, size, mtime FROM files");
      // The old table's triggers and index go with it; SCHEMA makes them again.
      this.db.exec("DROP TABLE files; ALTER TABLE files_v3 RENAME TO files;");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Where each source came from, from its front matter: a sync would read it only once the file changes. */
  private originals(): void {
    const rows = this.db.prepare("SELECT path FROM files WHERE kind = 'source'").all() as { path: string }[];
    const set = this.db.prepare("UPDATE files SET original = ? WHERE path = ?");
    for (const { path } of rows) {
      if (!existsSync(path)) continue;
      const original = parseNote(readFileSync(path, "utf8")).meta.original;
      if (typeof original === "string" && original) set.run(original, path);
    }
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
    this.opts.onChange?.();
    return this.topicAt(name);
  }

  setAbout(topicName: string, aboutIn: string): Topic {
    const topic = this.need(topicName);
    const file = join(topic.dir, ABOUT);
    const old = existsSync(file) ? parseNote(readFileSync(file, "utf8")).meta : {};
    atomicWrite(file, writeFront({ topic: topic.name, created: old.created ?? new Date(this.now()).toISOString(), folders: old.folders }, String(aboutIn ?? "").trim().slice(0, TOPIC_LIMITS.about) || topic.name));
    this.opts.onChange?.();
    return this.topicAt(topic.name);
  }

  /** The folders linked to a topic, as its topic.md lists them. */
  linkedFolders(topicName: string): LinkedFolder[] {
    const file = join(this.need(topicName).dir, ABOUT);
    const list = existsSync(file) ? parseNote(readFileSync(file, "utf8")).meta.folders : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item): LinkedFolder[] => {
      const it = item && typeof item === "object" ? (item as { path?: unknown; meaning?: unknown }) : null;
      if (!it || typeof it.path !== "string" || !it.path) return [];
      const meaning = it.meaning && typeof it.meaning === "object" ? Object.fromEntries(Object.entries(it.meaning).filter((e): e is [string, boolean] => typeof e[1] === "boolean")) : {};
      return [{ path: it.path, meaning }];
    });
  }

  setLinkedFolders(topicName: string, folders: readonly LinkedFolder[]): void {
    const topic = this.need(topicName);
    const file = join(topic.dir, ABOUT);
    const old = existsSync(file) ? parseNote(readFileSync(file, "utf8")) : { meta: {}, body: topic.name };
    atomicWrite(file, writeFront({ ...old.meta, topic: topic.name, folders: folders.map((f) => ({ path: f.path, meaning: f.meaning })) }, old.body.trim() || topic.name));
    this.opts.onChange?.();
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
    // Linked files are kept by their own sync (topics/linked.ts).
    const known = new Map((this.db.prepare("SELECT path, size, mtime FROM files WHERE topic_key = ? AND kind != 'linked'").all(topicKey) as unknown as Pick<Row, "path" | "size" | "mtime">[]).map((r) => [r.path, r]));
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
          const original = kind === "source" && typeof meta.original === "string" && meta.original ? meta.original : null;
          this.db
            .prepare("INSERT INTO files (path, topic_key, kind, title, title_key, body, size, mtime, original) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET topic_key = excluded.topic_key, kind = excluded.kind, title = excluded.title, title_key = excluded.title_key, body = excluded.body, size = excluded.size, mtime = excluded.mtime, original = excluded.original")
            .run(path, topicKey, kind, title, keyOf(title), body, st.size, st.mtimeMs, original);
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

  /** By its title, else by one of its other names. */
  readNote(topicName: string, title: string): TopicNote | null {
    const topic = this.need(topicName);
    const path = this.notePath(topic, title);
    if (path) return this.noteAt(topic.name, path);
    const key = keyOf(String(title ?? "").replace(/\s+/g, " ").trim());
    return key ? (this.listNotes(topic.name).find((n) => n.aliases.some((a) => keyOf(a) === key)) ?? null) : null;
  }

  /**
   * The page that is already about this, when a new page would be a
   * second one: its title or another name is the new title or one of the
   * new names. The page of the same title is the one being updated.
   */
  samePage(topicName: string, title: string, aliases: readonly string[]): string | null {
    const own = keyOf(String(title ?? "").replace(/\s+/g, " ").trim());
    const wanted = new Set([own, ...aliases.map((a) => keyOf(String(a).replace(/\s+/g, " ").trim()))].filter(Boolean));
    for (const note of this.listNotes(topicName)) {
      if (keyOf(note.title) === own) continue;
      if ([note.title, ...note.aliases].some((name) => wanted.has(keyOf(name)))) return note.title;
    }
    return null;
  }

  /** The files a page cites that changed since it was written, or are no longer there. */
  staleCites(topicName: string, note: TopicNote): string[] {
    return note.cites.filter((c) => this.citedHash(topicName, c.file) !== c.sha256).map((c) => c.file);
  }

  /** A cited file's SHA-256 now: a linked file by its name, else a source; null when there is none. */
  citedHash(topicName: string, file: string): string | null {
    const linked = this.readLinked(topicName, file);
    if (linked) return (this.db.prepare("SELECT sha256 FROM files WHERE path = ?").get(linked.path) as { sha256: string | null } | undefined)?.sha256 ?? null;
    return this.readSource(topicName, file)?.source.sha256 ?? null;
  }

  /** The pages citing a file, by title. */
  citing(topicName: string, file: string): string[] {
    return this.listNotes(topicName).filter((n) => n.cites.some((c) => c.file === file)).map((n) => n.title);
  }

  /**
   * What a [[link]] leads to: a page by its title or another name, else a
   * linked file by its path or name, with or without its folder's name or
   * its kind. Two files of the same name: ambiguous, the folder decides.
   */
  resolveWiki(topicName: string, target: string): { kind: "note"; title: string } | { kind: "file"; name: string } | { kind: "ambiguous"; names: string[] } | null {
    const wanted = String(target ?? "").replace(/\s+/g, " ").trim();
    if (!wanted) return null;
    const note = this.readNote(topicName, wanted);
    if (note) return { kind: "note", title: note.title };
    const key = keyOf(wanted);
    const names = this.linkedRows(topicName)
      .map((r) => linkedName(r.folder, r.rel))
      .filter((name) => {
        const rel = name.slice(name.indexOf("/") + 1);
        return [name, stemOf(name), rel, stemOf(rel), posix.basename(rel), stemOf(posix.basename(rel))].some((form) => keyOf(form) === key);
      });
    if (names.length === 0) return null;
    return names.length === 1 ? { kind: "file", name: names[0]! } : { kind: "ambiguous", names: names.sort() };
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
  writeNote(topicName: string, input: { title: string; text: string; by: NoteAuthor; sources: string[]; aliases?: string[]; cites?: TopicCite[] }): { note: TopicNote; replaced: boolean; previous: string | null } {
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
    const aliases = input.aliases?.length ? input.aliases : undefined;
    const cites = input.cites?.length ? input.cites : undefined;
    atomicWrite(path, writeFront({ title, aliases, created: typeof created === "string" ? created : at, updated: at, by: input.by, sources: input.sources, cites }, text));
    this.opts.onChange?.();
    return { note: this.noteAt(topic.name, path), replaced: previous !== null, previous };
  }

  /** Whether a note is one Vunemi makes by code (front matter `generated: true`), as the Index is. */
  generatedNote(topicName: string, title: string): boolean {
    const path = this.notePath(this.need(topicName), title);
    return path !== null && parseNote(readFileSync(path, "utf8")).meta.generated === true;
  }

  /**
   * Writes a note Vunemi makes by code, unless a note of that title is the
   * user's (no \`generated: true\`). Not written when its text is the same.
   */
  writeGenerated(topicName: string, title: string, text: string): "written" | "unchanged" | "theirs" {
    const topic = this.need(topicName);
    const existing = this.notePath(topic, title);
    if (existing) {
      const { meta, body } = parseNote(readFileSync(existing, "utf8"));
      if (meta.generated !== true) return "theirs";
      if (body.trim() === text.trim()) return "unchanged";
    }
    mkdirSync(join(topic.dir, NOTES), { recursive: true });
    this.inside(join(topic.dir, NOTES));
    const path = existing ?? join(topic.dir, NOTES, `${cleanName(title, "title")}.md`);
    atomicWrite(path, writeFront({ title, generated: true, by: "vunemi", updated: new Date(this.now()).toISOString() }, text));
    this.opts.onChange?.();
    return "written";
  }

  /** Puts a note back as it was (undo): the old text, or no note when there was none. */
  restoreNote(topicName: string, title: string, previous: string | null, trash: (path: string) => void): void {
    const topic = this.need(topicName);
    const path = this.notePath(topic, title);
    if (previous === null) {
      if (path) trash(path);
    } else atomicWrite(path ?? join(topic.dir, NOTES, `${cleanName(title, "title")}.md`), previous);
    this.opts.onChange?.();
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
      aliases: strings(meta.aliases),
      cites: citesOf(meta.cites),
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
    const markdown = cutToSource(input.markdown);
    const path = join(dir, `${name}.md`);
    atomicWrite(path, writeFront({ original: input.original, bytes: input.bytes, sha256: input.sha256, added: new Date(this.now()).toISOString() }, markdown));
    this.opts.onChange?.();
    return { source: sourceAt(topic.name, path), added: true };
  }

  readSource(topicName: string, name: string): { source: TopicSource; text: string } | null {
    const topic = this.need(topicName);
    const key = keyOf(String(name ?? "").trim().replace(/\.md$/i, ""));
    const path = mdFiles(join(topic.dir, SOURCES)).find((p) => keyOf(basename(p, ".md")) === key);
    return path ? { source: sourceAt(topic.name, path), text: parseNote(readFileSync(path, "utf8")).body } : null;
  }

  /** A topic's notes and sources by title, newest first, from the index: no file is read whole. */
  outline(topicName: string): { notes: { title: string; path: string; mtime: number }[]; sources: { title: string; path: string; mtime: number }[] } {
    const topic = this.need(topicName);
    this.sync(topic);
    const rows = this.db.prepare("SELECT kind, title, path, mtime FROM files WHERE topic_key = ? ORDER BY mtime DESC").all(keyOf(topic.name)) as unknown as { kind: "note" | "source"; title: string; path: string; mtime: number }[];
    const of = (kind: string) => rows.filter((r) => r.kind === kind && existsSync(r.path)).map(({ title, path, mtime }) => ({ title, path, mtime }));
    return { notes: of("note"), sources: of("source") };
  }

  /** The file of a source by name, any case; null when there is none. */
  sourcePath(topicName: string, name: string): string | null {
    const topic = this.need(topicName);
    const key = keyOf(String(name ?? "").trim().replace(/\.md$/i, ""));
    return mdFiles(join(topic.dir, SOURCES)).find((p) => keyOf(basename(p, ".md")) === key) ?? null;
  }

  // -- linked files -------------------------------------------------------------------

  /** A linked file into the index, replacing what it had: words always, parts only for search by meaning. */
  putLinked(topicName: string, row: LinkedRow & { title: string; body: string; parts: boolean }): void {
    const topicKey = keyOf(this.need(topicName).name);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO files (path, topic_key, kind, title, title_key, body, size, mtime, folder, rel, sha256, outline) VALUES (?, ?, 'linked', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET topic_key = excluded.topic_key, kind = excluded.kind, title = excluded.title, title_key = excluded.title_key, body = excluded.body, size = excluded.size, mtime = excluded.mtime, folder = excluded.folder, rel = excluded.rel, sha256 = excluded.sha256, outline = excluded.outline")
        .run(row.path, topicKey, row.title, keyOf(row.title), row.body, row.size, row.mtime, row.folder, row.rel, row.sha256, JSON.stringify(outlineOf(row.body)));
      this.db.prepare("DELETE FROM parts WHERE path = ?").run(row.path);
      this.forgetSkeleton(row.path);
      const link = this.db.prepare("INSERT INTO links (topic_key, folder, src, dst, dst_stem) VALUES (?, ?, ?, ?, ?)");
      for (const target of linksOf(row.body)) {
        const dst = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(row.rel), target));
        if (dst === "." || dst === ".." || dst.startsWith("../") || stemOf(dst) === stemOf(row.rel)) continue;
        link.run(topicKey, row.folder, row.path, dst, stemOf(dst));
      }
      const { rowid } = this.db.prepare("SELECT rowid FROM files WHERE path = ?").get(row.path) as { rowid: number };
      const code = this.db.prepare("INSERT INTO codes (file, code, count, defined) VALUES (?, ?, ?, ?)");
      for (const use of codesOf(row.body)) code.run(rowid, use.code, use.count, use.defined ? 1 : 0);
      if (row.parts) {
        const insert = this.db.prepare("INSERT INTO parts (path, start, text) VALUES (?, ?, ?)");
        for (const part of partsOf(row.body)) insert.run(row.path, part.start, part.text);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Search by meaning on or off for some of a folder's linked files: parts
   * made from the text the index holds, nothing read again; or removed,
   * vectors with them.
   */
  setParts(topicName: string, folder: string, rels: readonly string[], on: boolean): void {
    const topicKey = keyOf(this.need(topicName).name);
    const wanted = new Set(rels);
    const rows = (this.db.prepare("SELECT path, rel, body FROM files WHERE topic_key = ? AND kind = 'linked' AND folder = ?").all(topicKey, folder) as { path: string; rel: string; body: string }[]).filter((r) => wanted.has(r.rel));
    const has = this.db.prepare("SELECT 1 FROM parts WHERE path = ? LIMIT 1");
    const insert = this.db.prepare("INSERT INTO parts (path, start, text) VALUES (?, ?, ?)");
    const drop = this.db.prepare("DELETE FROM parts WHERE path = ?");
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (!on) drop.run(row.path);
        else if (!has.get(row.path)) for (const part of partsOf(row.body)) insert.run(row.path, part.start, part.text);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A linked file touched but not changed: its new size and time, its words and vectors kept. */
  touchLinked(path: string, size: number, mtime: number): void {
    this.db.prepare("UPDATE files SET size = ?, mtime = ? WHERE path = ? AND kind = 'linked'").run(size, mtime, path);
  }

  /** Linked files out of the index: gone, or their folder is. */
  dropLinked(topicName: string, paths: readonly string[]): void {
    const topicKey = keyOf(this.need(topicName).name);
    this.db.exec("BEGIN");
    try {
      for (const path of paths) {
        if (!this.db.prepare("SELECT 1 FROM files WHERE path = ? AND topic_key = ? AND kind = 'linked'").get(path, topicKey)) continue;
        this.forgetSkeleton(path);
        this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
        this.db.prepare("DELETE FROM parts WHERE path = ?").run(path);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private forgetSkeleton(path: string): void {
    this.db.prepare("DELETE FROM links WHERE src = ?").run(path);
    this.db.prepare("DELETE FROM codes WHERE file = (SELECT rowid FROM files WHERE path = ?)").run(path);
  }

  /** The files of its folder a linked file links to, in the order it does, each once. */
  linksFrom(path: string): string[] {
    const from = this.db.prepare("SELECT folder, rel FROM files WHERE path = ? AND kind = 'linked'").get(path) as { folder: string; rel: string } | undefined;
    if (!from) return [];
    const targets = this.db.prepare("SELECT dst FROM links WHERE src = ? ORDER BY rowid").all(path) as { dst: string }[];
    if (targets.length === 0) return [];
    const byRel = new Map((this.db.prepare("SELECT path, rel FROM files WHERE folder = ? AND kind = 'linked'").all(from.folder) as { path: string; rel: string }[]).map((r) => [r.rel, r.path]));
    const rels = new Set(byRel.keys());
    const out = new Set<string>();
    for (const { dst } of targets) {
      // Already relative to the folder: resolved from its top.
      const rel = resolveLink("", dst, rels);
      if (rel && rel !== from.rel) out.add(byRel.get(rel)!);
    }
    return [...out];
  }

  /** The files of its folder that link to a linked file. */
  linksTo(path: string): string[] {
    const to = this.db.prepare("SELECT folder, rel FROM files WHERE path = ? AND kind = 'linked'").get(path) as { folder: string; rel: string } | undefined;
    if (!to) return [];
    const rows = this.db
      .prepare("SELECT DISTINCT l.src FROM links l JOIN files f ON f.path = l.src WHERE l.folder = ? AND l.dst_stem = ? AND l.src != ? ORDER BY l.src")
      .all(to.folder, stemOf(to.rel), path) as { src: string }[];
    return rows.map((r) => r.src);
  }

  /** The linked files of a topic that use a code: those defining it first, then the most uses. */
  codeFiles(topicName: string, code: string, limit = 20): { path: string; folder: string; rel: string; title: string; count: number; defined: boolean }[] {
    const rows = this.db
      .prepare("SELECT f.path, f.folder, f.rel, f.title, c.count, c.defined FROM codes c JOIN files f ON f.rowid = c.file WHERE f.topic_key = ? AND c.code = ? ORDER BY c.defined DESC, c.count DESC, f.path LIMIT ?")
      .all(keyOf(this.need(topicName).name), code, limit) as { path: string; folder: string; rel: string; title: string; count: number; defined: number }[];
    return rows.map((r) => ({ ...r, defined: r.defined === 1 }));
  }

  /** Linked files by the names the tools give them (linkedName), those not indexed left out. */
  linkedNames(paths: readonly string[]): string[] {
    const get = this.db.prepare("SELECT folder, rel FROM files WHERE path = ? AND kind = 'linked'");
    return paths.flatMap((path) => {
      const row = get.get(path) as { folder: string; rel: string } | undefined;
      return row ? [linkedName(row.folder, row.rel)] : [];
    });
  }

  /** The linked files most linked to from their own folder, with how many files link to each. */
  linkHubs(topicName: string, limit: number): { path: string; name: string; title: string; inbound: number }[] {
    const topicKey = keyOf(this.need(topicName).name);
    const rows = this.db
      .prepare("SELECT folder, dst_stem, COUNT(DISTINCT src) AS n FROM links WHERE topic_key = ? GROUP BY folder, dst_stem ORDER BY n DESC, dst_stem LIMIT ?")
      .all(topicKey, limit * 2) as { folder: string; dst_stem: string; n: number }[];
    const byStem = new Map<string, Map<string, { path: string; rel: string; title: string }>>();
    const out: { path: string; name: string; title: string; inbound: number }[] = [];
    for (const row of rows) {
      let files = byStem.get(row.folder);
      if (!files) {
        files = new Map();
        for (const f of this.db.prepare("SELECT path, rel, title FROM files WHERE folder = ? AND kind = 'linked'").all(row.folder) as { path: string; rel: string; title: string }[]) files.set(stemOf(f.rel), f);
        byStem.set(row.folder, files);
      }
      const file = files.get(row.dst_stem);
      if (file && out.length < limit) out.push({ path: file.path, name: linkedName(row.folder, file.rel), title: file.title, inbound: row.n });
    }
    return out;
  }

  /** The codes most of a topic's linked files use, and the file defining each when one does. */
  topCodes(topicName: string, limit: number): { code: string; files: number; definedIn: string | null }[] {
    const topicKey = keyOf(this.need(topicName).name);
    const rows = this.db
      .prepare("SELECT c.code, COUNT(*) AS n FROM codes c JOIN files f ON f.rowid = c.file WHERE f.topic_key = ? GROUP BY c.code ORDER BY n DESC, c.code LIMIT ?")
      .all(topicKey, limit) as { code: string; n: number }[];
    const defining = this.db.prepare("SELECT f.folder, f.rel FROM codes c JOIN files f ON f.rowid = c.file WHERE f.topic_key = ? AND c.code = ? AND c.defined = 1 ORDER BY c.count DESC, f.path LIMIT 1");
    return rows.map((r) => {
      const at = defining.get(topicKey, r.code) as { folder: string; rel: string } | undefined;
      return { code: r.code, files: r.n, definedIn: at ? linkedName(at.folder, at.rel) : null };
    });
  }

  /** A linked file's headings, as kept when it was indexed. */
  outlineOf(path: string): string[] {
    const row = this.db.prepare("SELECT outline FROM files WHERE path = ?").get(path) as { outline: string | null } | undefined;
    return row?.outline ? (JSON.parse(row.outline) as string[]) : [];
  }

  /** A linked file by the name the tools give it (linkedName), with its text as indexed. */
  readLinked(topicName: string, name: string): { folder: string; rel: string; path: string; title: string; text: string } | null {
    const topicKey = keyOf(this.need(topicName).name);
    const wanted = String(name ?? "").trim().replace(/^\/+/, "");
    const rows = this.db.prepare("SELECT path, folder, rel, title, body FROM files WHERE topic_key = ? AND kind = 'linked' AND rel = ?").all(topicKey, wanted.slice(wanted.indexOf("/") + 1)) as { path: string; folder: string; rel: string; title: string; body: string }[];
    const row = rows.find((r) => linkedName(r.folder, r.rel) === wanted);
    return row ? { folder: row.folder, rel: row.rel, path: row.path, title: row.title, text: row.body } : null;
  }

  /**
   * Sources copied from a file that a linked folder now holds (the same
   * document: same folder, same name, any kind). Search shows the linked
   * file; the Memory page offers to remove the copies.
   */
  copiesInLinked(topicName: string): string[] {
    const topic = this.need(topicName);
    this.sync(topic);
    return [...this.copiesIn([keyOf(topic.name)])].filter((path) => existsSync(path));
  }

  private copiesIn(topicKeys: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const topicKey of topicKeys) {
      const docs = new Set((this.db.prepare("SELECT path FROM files WHERE topic_key = ? AND kind = 'linked'").all(topicKey) as { path: string }[]).map((r) => docKey(r.path)));
      if (docs.size === 0) continue;
      for (const row of this.db.prepare("SELECT path, original FROM files WHERE topic_key = ? AND kind = 'source' AND original IS NOT NULL").all(topicKey) as { path: string; original: string }[]) {
        if (docs.has(docKey(row.original))) out.add(row.path);
      }
    }
    return out;
  }

  /** A topic's linked files as indexed: all, or one folder's. */
  linkedRows(topicName: string, folder?: string): LinkedRow[] {
    const topicKey = keyOf(this.need(topicName).name);
    const rows = folder === undefined
      ? this.db.prepare("SELECT path, rel, folder, size, mtime, sha256 FROM files WHERE topic_key = ? AND kind = 'linked' ORDER BY path").all(topicKey)
      : this.db.prepare("SELECT path, rel, folder, size, mtime, sha256 FROM files WHERE topic_key = ? AND kind = 'linked' AND folder = ? ORDER BY path").all(topicKey, folder);
    return rows as unknown as LinkedRow[];
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
      .prepare(`SELECT p.path, p.start, p.text, p.vector, f.kind, f.topic_key, f.title, f.folder, f.rel FROM parts p JOIN files f ON f.path = p.path WHERE p.vector_model = ? AND p.vector IS NOT NULL ${where}`)
      .iterate(...(topicName ? [model, keyOf(topicName)] : [model])) as Iterable<{ path: string; start: number; text: string; vector: Uint8Array; kind: Row["kind"]; topic_key: string; title: string; folder: string | null; rel: string | null }>;
    const best = new Map<string, TopicHit & { score: number }>();
    const copies = this.copiesIn([...names.keys()]);
    for (const row of rows) {
      const topic = names.get(row.topic_key);
      if (!topic || copies.has(row.path)) continue;
      const vector = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      let score = 0;
      if (vector.length === query.length) for (let i = 0; i < vector.length; i++) score += vector[i]! * query[i]!;
      const was = best.get(row.path);
      if (!was || score > was.score) best.set(row.path, { ...hitKind(row), topic, title: row.title, snippet: row.text, path: row.path, at: row.start, score });
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
      .prepare(`SELECT f.kind, f.topic_key, f.title, f.path, f.folder, f.rel, snippet(files_fts, 1, '', '', '…', 16) AS snip FROM files_fts JOIN files f ON f.rowid = files_fts.rowid WHERE files_fts MATCH ? ${topicName ? "AND f.topic_key = ?" : ""} ORDER BY bm25(files_fts) LIMIT ?`)
      .all(...(topicName ? [match, keyOf(topicName), limit] : [match, limit])) as unknown as { kind: Row["kind"]; topic_key: string; title: string; path: string; folder: string | null; rel: string | null; snip: string }[];
    const copies = this.copiesIn([...names.keys()]);
    return rows.filter((r) => names.has(r.topic_key) && !copies.has(r.path) && existsSync(r.path)).map((r) => ({ ...hitKind(r), topic: names.get(r.topic_key)!, title: r.title, snippet: r.snip.replace(/\s+/g, " ").trim(), path: r.path }));
  }
}

/** How the tools and the page name a linked file: its folder's name, then its path inside it. */
export function linkedName(folder: string, rel: string): string {
  return `${basename(folder)}/${rel}`;
}

/** A path without its kind: how a link to x.html reaches x.md. */
const stemOf = (rel: string): string => {
  const ext = posix.extname(rel);
  return ext ? rel.slice(0, -ext.length) : rel;
};

/** One document's files share this: the folder and the name without its kind. */
const docKey = (path: string): string => keyOf(join(dirname(path), basename(path, extname(path))));

/** A file's text as a topic keeps it: at most TOPIC_LIMITS.sourceChars, saying where it was cut. */
export function cutToSource(markdown: string): string {
  if (markdown.length <= TOPIC_LIMITS.sourceChars) return markdown;
  return `${markdown.slice(0, TOPIC_LIMITS.sourceChars)}\n\n[Cut here: the file's text was longer than ${TOPIC_LIMITS.sourceChars.toLocaleString("en-GB")} characters.]`;
}

/** What a hit is, as the tools and the page name it: a linked file says where it is. */
function hitKind(row: { kind: Row["kind"]; folder: string | null; rel: string | null }): Pick<TopicHit, "kind" | "folder" | "rel"> {
  return row.kind === "linked" ? { kind: "file", folder: row.folder ?? "", rel: row.rel ?? "" } : { kind: row.kind };
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
