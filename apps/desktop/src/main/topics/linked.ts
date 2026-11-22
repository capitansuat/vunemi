/**
 * Folders linked to a topic: their files are searched and read where they
 * are, never copied (tenami/docs/superpowers/specs/2026-11-22-topic-wiki-design.md).
 *
 * A pass walks each linked folder, compares what it finds with the index by
 * size and time, and reads what is new or changed, a batch at a time, for
 * as long as Vunemi is idle. Text is read as it is; other kinds go through
 * MarkItDown once and are kept in Vunemi's data folder by their SHA-256, so
 * a file touched but not changed, or seen again later, costs no conversion.
 * Nothing is ever written into a linked folder.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { Roots } from "@vunemi/files";
import { why } from "../markdown.js";
import { INDEX_TITLE, writeIndex } from "./index-page.js";
import { cutToSource, type LinkedFolder, type TopicStore } from "./store.js";
import { type TopicToolsOptions, walkFolder } from "./tools.js";

/** Files read between two looks at whether Vunemi is still idle. */
export const LINKED_BATCH = 20;
/** How long MarkItDown may take on one batch. */
const CONVERT_MS = 20 * 60_000;
const TEXT = new Set([".md", ".markdown", ".txt"]);

export type FolderState = "ok" | "missing" | "refused";
export type SyncOutcome = "done" | "paused" | "failed";

export interface LinkedSyncOptions {
  store: TopicStore;
  /** The folders Vunemi may read: a linked folder must stay inside them. */
  roots: Pick<Roots, "resolve">;
  convert: TopicToolsOptions["convert"];
  /** Where converted files are kept, by their SHA-256. */
  cacheDir: string;
  /** Whether a file is searched by meaning too (its parts are made). */
  inMeaning: (topic: string, folder: LinkedFolder, rel: string) => boolean;
  /** After a batch was put in the index. */
  onIndexed?: (topic: string, paths: string[]) => void;
  log?: (line: string) => void;
}

interface Found {
  path: string;
  rel: string;
  size: number;
  mtime: number;
}

const keyOf = (topic: string, folder: string) => `${topic}\u0000${folder}`;

export class LinkedSync {
  private running: Promise<SyncOutcome> | null = null;
  private readonly states = new Map<string, FolderState>();
  private readonly found = new Map<string, number>();
  /** Topics whose linked files changed since their Index was last made. */
  private readonly changed = new Set<string>();
  /** The page titles each topic's Index was last made with. */
  private readonly pages = new Map<string, string>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: LinkedSyncOptions) {
    this.log = opts.log ?? ((line) => console.error(line));
  }

  state(topic: string, folder: string): FolderState {
    return this.states.get(keyOf(topic, folder)) ?? "ok";
  }

  /** The readable files the last pass found in a folder, and how many of them the index holds. */
  counts(topic: string, folder: string): { files: number; indexed: number } {
    return { files: this.found.get(keyOf(topic, folder)) ?? 0, indexed: this.opts.store.linkedRows(topic, folder).length };
  }

  /** One pass over every topic's linked folders; a second call while one runs gets the same pass. */
  run(goOn: () => boolean): Promise<SyncOutcome> {
    this.running ??= this.pass(goOn)
      .catch((error: unknown): SyncOutcome => {
        this.log(`[vunemi] topic folders: ${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      })
      .finally(() => (this.running = null));
    return this.running;
  }

  private async pass(goOn: () => boolean): Promise<SyncOutcome> {
    const { store } = this.opts;
    for (const topic of store.listTopics()) {
      const folders = store.linkedFolders(topic.name);
      const linked = new Set(folders.map((f) => f.path));
      // An unlinked folder's files leave the index.
      const orphans = store.linkedRows(topic.name).filter((r) => !linked.has(r.folder)).map((r) => r.path);
      if (orphans.length) {
        store.dropLinked(topic.name, orphans);
        this.changed.add(topic.name);
      }
      // Not made while a task waits: the topic stays marked for the next pass.
      for (const folder of folders) {
        if ((await this.folder(topic.name, folder, goOn)) === "paused") return "paused";
      }
      this.index(topic.name);
    }
    return "done";
  }

  /** The topic's Index made again when its files or its pages changed since it last was. */
  private index(topic: string): void {
    const pages = this.opts.store.listNotes(topic).map((n) => n.title).filter((t) => t !== INDEX_TITLE).sort().join("\n");
    if (!this.changed.has(topic) && this.pages.get(topic) === pages) return;
    try {
      writeIndex(this.opts.store, topic);
      this.changed.delete(topic);
      this.pages.set(topic, pages);
    } catch (error) {
      // The files stay searchable; the map is made again next pass.
      this.log(`[vunemi] topic index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async folder(topic: string, folder: LinkedFolder, goOn: () => boolean): Promise<SyncOutcome> {
    const { store } = this.opts;
    const key = keyOf(topic, folder.path);
    let real: string;
    try {
      real = this.opts.roots.resolve(folder.path, "read");
    } catch {
      return this.away(topic, folder.path, "refused");
    }
    if (!existsSync(real) || !statSync(real).isDirectory()) return this.away(topic, folder.path, "missing");
    this.states.set(key, "ok");

    const files: Found[] = [];
    await walkFolder(real, this.opts.convert !== null, (path, size, mtime) => {
      files.push({ path: join(folder.path, relative(real, path)), rel: relative(real, path).split(sep).join("/"), size, mtime });
    });
    this.found.set(key, files.length);

    const known = new Map(store.linkedRows(topic, folder.path).map((r) => [r.path, r]));
    const here = new Set(files.map((f) => f.path));
    const gone = [...known.keys()].filter((path) => !here.has(path));
    if (gone.length) {
      store.dropLinked(topic, gone);
      this.changed.add(topic);
    }

    const todo = files.filter((f) => {
      const was = known.get(f.path);
      return !was || was.size !== f.size || was.mtime !== f.mtime;
    });
    for (let at = 0; at < todo.length; at += LINKED_BATCH) {
      if (!goOn()) return "paused";
      const batch = todo.slice(at, at + LINKED_BATCH);
      const done = await this.batch(topic, folder, batch, known);
      if (done.length) {
        this.changed.add(topic);
        this.opts.onIndexed?.(topic, done);
      }
      // Let the window and the next request in between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return "done";
  }

  /** A folder that is gone or no longer open to Vunemi: its files leave search until it is back. */
  private away(topic: string, folder: string, state: FolderState): SyncOutcome {
    this.states.set(keyOf(topic, folder), state);
    const rows = this.opts.store.linkedRows(topic, folder).map((r) => r.path);
    if (rows.length) {
      this.opts.store.dropLinked(topic, rows);
      this.changed.add(topic);
    }
    return "done";
  }

  /** Reads a batch into the index; the paths it put there. */
  private async batch(topic: string, folder: LinkedFolder, batch: Found[], known: Map<string, { sha256: string }>): Promise<string[]> {
    const { store } = this.opts;
    const done: string[] = [];
    const bodies = new Map<string, string>();
    const hashes = new Map<string, string>();
    const toConvert: Found[] = [];
    for (const file of batch) {
      try {
        const sha = await sha256Stream(file.path);
        hashes.set(file.path, sha);
        if (known.get(file.path)?.sha256 === sha) {
          // Touched, not changed: words and vectors stay.
          store.touchLinked(file.path, file.size, file.mtime);
          done.push(file.path);
          continue;
        }
        if (TEXT.has(extname(file.path).toLowerCase())) bodies.set(file.path, await readFile(file.path, "utf8"));
        else {
          const cached = join(this.opts.cacheDir, `${sha}.md`);
          if (existsSync(cached)) bodies.set(file.path, await readFile(cached, "utf8"));
          else toConvert.push(file);
        }
      } catch (error) {
        this.log(`[vunemi] topic folder: ${file.rel}: ${why(error instanceof Error ? error.message : String(error))}`);
      }
    }
    if (toConvert.length && this.opts.convert) {
      const results = await this.opts.convert(toConvert.map((f) => f.path), AbortSignal.timeout(CONVERT_MS));
      mkdirSync(this.opts.cacheDir, { recursive: true, mode: 0o700 });
      for (const [i, file] of toConvert.entries()) {
        const result = results[i] ?? { error: "Not converted." };
        if ("error" in result) {
          this.log(`[vunemi] topic folder: ${file.rel}: ${why(result.error)}`);
          continue;
        }
        await writeFile(join(this.opts.cacheDir, `${hashes.get(file.path)}.md`), result.markdown, { mode: 0o600 });
        bodies.set(file.path, result.markdown);
      }
    }
    for (const file of batch) {
      const body = bodies.get(file.path);
      if (body === undefined) continue;
      store.putLinked(topic, {
        folder: folder.path,
        rel: file.rel,
        path: file.path,
        title: titleOf(body, file.path),
        body: cutToSource(body),
        size: file.size,
        mtime: file.mtime,
        sha256: hashes.get(file.path)!,
        parts: this.opts.inMeaning(topic, folder, file.rel),
      });
      done.push(file.path);
    }
    return done;
  }
}

/** The first heading, else the file's name without its kind. */
export function titleOf(markdown: string, path: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown.slice(0, 20_000));
  const title = heading?.[1]?.trim();
  return title ? title.slice(0, 200) : basename(path, extname(path));
}

/** Read in pieces, so a large file doesn't hold the main thread. */
function sha256Stream(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
