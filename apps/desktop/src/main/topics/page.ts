/**
 * What the Memory page asks of the topics: the tree, a note or source to
 * show, search, and the user's own changes. Everything the window sends is
 * checked here: names and titles are looked up in the topics folder, never
 * taken as paths. Errors are in the user's language; the store's own are
 * written for the model.
 */
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Roots } from "@vunemi/files";
import { t } from "@vunemi/i18n";
import type { TopicAddedView, TopicFileView, TopicNoteView, TopicSearchView, TopicSourceView, TopicTreeView } from "../../shared/ipc.js";
import { type LinkedSync, meaningOn, subfolderOf } from "./linked.js";
import type { TopicFound } from "./meaning.js";
import { cleanName, type LinkedFolder, linkedName, TOPIC_LIMITS, type TopicStore } from "./store.js";
import { addSourceFiles, pickedSources, SOURCE_KINDS, type TopicToolsOptions, walkFolder } from "./tools.js";

/** A source longer than this is shown cut; the file keeps all of it. */
export const SHOWN_CHARS = 200_000;
const SEARCH_HITS = 20;

export interface TopicPageDeps {
  store: TopicStore;
  find: ((query: string, topic: string | undefined, limit: number) => Promise<TopicFound>) | null;
  convert: TopicToolsOptions["convert"];
  /** Asks the user for files of these kinds (extensions without the dot) or folders; [] when cancelled. */
  pickFiles: (kinds: string[]) => Promise<string[]>;
  trash: (path: string) => Promise<void>;
  reveal: (path: string) => void;
  /** The topic is gone: the conversations in it leave it. */
  /** `temporary`: it was a temporary topic, so its conversations make none again. */
  leave: (topic: string, temporary?: true) => void;
  /** Something changed that the page shows. */
  changed: () => void;
  /** The folders Vunemi may read: a folder is linked only inside them. */
  roots: Pick<Roots, "resolve">;
  /** How each linked folder is doing (topics/linked.ts); null in a build without it. */
  linked: Pick<LinkedSync, "state" | "counts" | "subfolders" | "checks"> | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function topicPage(deps: TopicPageDeps) {
  const { store } = deps;

  /** The topic by the name the window sent, as its folder has it. */
  const topicOf = (name: unknown): string => {
    const topic = store.findTopic(text(name));
    if (!topic) throw new Error(t("topics.gone"));
    return topic.name;
  };

  const userName = (value: unknown, what: "topic" | "title"): string => {
    try {
      return cleanName(value, what);
    } catch {
      throw new Error(t(what === "topic" ? "topics.page.badName" : "topics.page.badTitle"));
    }
  };

  const noteView = (topic: string, title: string): TopicNoteView | null => {
    const note = store.readNote(topic, title);
    if (!note) return null;
    // Each [[link]] once: to a page (by its title or another name), to a linked file, or nowhere yet.
    const links: string[] = [];
    const files: { link: string; name: string }[] = [];
    const missing: string[] = [];
    for (const link of note.links) {
      const to = store.resolveWiki(topic, link);
      if (to?.kind === "note") links.push(link);
      else if (to?.kind === "file") files.push({ link, name: to.name });
      else missing.push(link);
    }
    return {
      topic,
      title: note.title,
      text: note.text,
      by: note.by,
      sources: note.sources,
      created: note.created,
      updated: note.updated,
      links,
      files,
      missing,
      aliases: note.aliases,
      cites: note.cites.map((c) => ({ name: c.file, ...(c.heading ? { heading: c.heading } : {}) })),
      stale: store.staleCites(topic, note),
      linkedFrom: store.backlinks(topic, note.title),
      stamp: statSync(note.path).mtimeMs,
    };
  };

  /** A linked folder's subfolders, the largest first: by the last pass's count, else by what the index holds. */
  const subfoldersOf = (topic: string, folder: LinkedFolder): { name: string; files: number; meaning: boolean }[] => {
    let counts = deps.linked?.subfolders(topic, folder.path);
    if (!counts) {
      counts = {};
      for (const row of store.linkedRows(topic, folder.path)) {
        const sub = subfolderOf(row.rel);
        if (sub) counts[sub] = (counts[sub] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, files]) => ({ name, files, meaning: meaningOn(folder, name, files) }));
  };

  return {
    tree(): TopicTreeView {
      return {
        root: store.root,
        canConvert: deps.convert !== null,
        topics: store.listTopics().map((topic) => {
          const outline = store.outline(topic.name);
          return {
            name: topic.name,
            about: topic.about,
            updatedAt: topic.updatedAt,
            ...(topic.temporary && { temporary: true as const }),
            notes: outline.notes.map((n) => ({ title: n.title, updatedAt: n.mtime })),
            sources: outline.sources.map((s) => ({ name: s.title, updatedAt: s.mtime })),
            folders: store.linkedFolders(topic.name).map((f) => ({
              path: f.path,
              state: deps.linked?.state(topic.name, f.path) ?? "ok",
              files: deps.linked?.counts(topic.name, f.path).files ?? 0,
              indexed: store.linkedRows(topic.name, f.path).length,
              subfolders: subfoldersOf(topic.name, f),
            })),
            copies: store.copiesInLinked(topic.name).length,
            checks: deps.linked?.checks(topic.name) ?? [],
          };
        }),
      };
    },

    note(topic: unknown, title: unknown): TopicNoteView | null {
      return noteView(topicOf(topic), text(title));
    },

    source(topicIn: unknown, name: unknown): TopicSourceView | null {
      const topic = topicOf(topicIn);
      const found = store.readSource(topic, text(name));
      if (!found) return null;
      const { source } = found;
      return {
        topic,
        name: source.name,
        original: source.original,
        originalThere: !!source.original && existsSync(source.original),
        added: source.added,
        bytes: source.bytes,
        chars: source.chars,
        text: found.text.slice(0, SHOWN_CHARS),
        cut: found.text.length > SHOWN_CHARS,
      };
    },

    async search(query: unknown, topicIn: unknown): Promise<TopicSearchView> {
      const words = text(query).trim().slice(0, 500);
      if (!words) return { hits: [], pending: 0, byMeaning: false };
      const topic = topicIn === null || topicIn === undefined ? undefined : topicOf(topicIn);
      const found = deps.find ? await deps.find(words, topic, SEARCH_HITS) : { hits: store.search(words, topic, SEARCH_HITS), pending: 0, byMeaning: false };
      return {
        hits: found.hits.map((h) => ({ kind: h.kind, topic: h.topic, title: h.title, snippet: h.snippet.replace(/\s+/g, " ").trim().slice(0, 300), ...(h.kind === "file" && { name: linkedName(h.folder ?? "", h.rel ?? "") }) })),
        pending: found.pending,
        byMeaning: found.byMeaning,
      };
    },

    /** The user's own note: new, or edited and perhaps renamed. Nothing is written over a change made meanwhile. */
    async saveNote(topicIn: unknown, note: unknown, was: unknown): Promise<TopicNoteView> {
      const topic = topicOf(topicIn);
      const input = (note ?? {}) as { title?: unknown; text?: unknown };
      const title = userName(input.title, "title");
      const body = text(input.text).trim();
      if (!body) throw new Error(t("topics.page.empty"));
      if (body.length > TOPIC_LIMITS.text) throw new Error(t("topics.page.tooLong", { max: TOPIC_LIMITS.text.toLocaleString() }));
      const before = was && typeof was === "object" ? (was as { title?: unknown; stamp?: unknown }) : null;
      const old = before ? store.readNote(topic, text(before.title)) : null;
      if (before && !old) throw new Error(t("topics.page.changed"));
      if (old && statSync(old.path).mtimeMs !== before?.stamp) throw new Error(t("topics.page.changed"));
      const renamed = old && old.title.toLowerCase() !== title.toLowerCase();
      // A new title must be free: a rename or a new note never replaces another note.
      if ((!old || renamed) && store.readNote(topic, title)) throw new Error(t("topics.page.taken", { title }));
      if ((!old || renamed) && store.outline(topic).notes.length >= TOPIC_LIMITS.notes) throw new Error(t("topics.page.full", { max: TOPIC_LIMITS.notes }));
      store.writeNote(topic, { title, text: body, by: "user", sources: old?.sources ?? [], aliases: old?.aliases ?? [], cites: old?.cites ?? [] });
      if (renamed) await deps.trash(old.path);
      deps.changed();
      return noteView(topic, title)!;
    },

    async deleteNote(topicIn: unknown, title: unknown): Promise<void> {
      const note = store.readNote(topicOf(topicIn), text(title));
      if (!note) return;
      await deps.trash(note.path);
      deps.changed();
    },

    async deleteSource(topicIn: unknown, name: unknown): Promise<void> {
      const path = store.sourcePath(topicOf(topicIn), text(name));
      if (!path) return;
      await deps.trash(path);
      deps.changed();
    },

    create(name: unknown, about: unknown): void {
      const clean = userName(name, "topic");
      if (store.findTopic(clean)) throw new Error(t("topics.page.exists", { topic: clean }));
      store.createTopic(clean, text(about));
    },

    setAbout(topicIn: unknown, about: unknown): void {
      store.setAbout(topicOf(topicIn), text(about));
    },

    /**
     * Files picked one by one are copied in as sources; a picked folder is
     * linked: its files stay where they are and are read there (the user's
     * decision, 22 Nov).
     */
    async addSources(topicIn: unknown): Promise<TopicAddedView | null> {
      const topic = topicOf(topicIn);
      const picked = await deps.pickFiles(SOURCE_KINDS(deps.convert !== null));
      if (picked.length === 0) return null;
      const canConvert = deps.convert !== null;
      const isFolder = (path: string) => existsSync(path) && statSync(path).isDirectory();
      const view: TopicAddedView = { added: [], already: [], failed: [], skipped: 0, left: 0, copies: 0, stopped: false, linked: [] };
      for (const folder of picked.filter(isFolder)) {
        try {
          deps.roots.resolve(folder, "read");
        } catch {
          view.failed.push({ file: basename(folder), error: t("topics.page.folderRefused") });
          continue;
        }
        const now = store.linkedFolders(topic);
        if (now.some((f) => folder === f.path || folder.startsWith(`${f.path}/`))) {
          view.already.push(basename(folder));
          continue;
        }
        let files = 0;
        const walked = await walkFolder(folder, canConvert, () => files++);
        view.skipped += walked.skipped;
        view.copies += walked.copies;
        view.stopped ||= walked.stopped;
        // A folder inside the new one is covered by it.
        store.setLinkedFolders(topic, [...now.filter((f) => !f.path.startsWith(`${folder}/`)), { path: folder, meaning: {} }]);
        view.linked.push({ folder, files });
      }
      const single = picked.filter((path) => !isFolder(path));
      if (single.length > 0) {
        const room = Math.max(0, TOPIC_LIMITS.sources - store.outline(topic).sources.length);
        const { ok, refused, left } = await pickedSources(single, canConvert, room);
        view.failed.push(...refused.map((r) => ({ file: basename(r.path), error: r.error })));
        view.left += left;
        if (ok.length > 0) {
          const { results } = await addSourceFiles(store, deps.convert, topic, ok, AbortSignal.timeout(30 * 60_000));
          for (const r of results) {
            if ("error" in r) view.failed.push({ file: basename(r.path), error: r.error });
            else (r.added ? view.added : view.already).push(r.name);
          }
        }
      }
      if (view.linked.length > 0 || view.added.length > 0) deps.changed();
      return view;
    },

    /** The folder leaves the topic; its files stay where they are and leave search on the next pass. */
    /** The user's switch for a subfolder: its files' parts made from the index, or removed. */
    setMeaning(topicIn: unknown, folderIn: unknown, subfolderIn: unknown, on: unknown): void {
      const topic = topicOf(topicIn);
      const folders = store.linkedFolders(topic);
      const folder = folders.find((f) => f.path === text(folderIn));
      const sub = text(subfolderIn);
      if (!folder) throw new Error(t("topics.gone"));
      if (!sub || sub.includes("/") || typeof on !== "boolean") throw new Error("Not a subfolder of the linked folder.");
      store.setLinkedFolders(topic, folders.map((f) => (f === folder ? { ...f, meaning: { ...f.meaning, [sub]: on } } : f)));
      store.setParts(topic, folder.path, store.linkedRows(topic, folder.path).map((r) => r.rel).filter((rel) => subfolderOf(rel) === sub), on);
      // Turned on: the new parts are searched by meaning once Vunemi is idle.
      deps.changed();
    },

    async unlink(topicIn: unknown, folder: unknown): Promise<void> {
      const topic = topicOf(topicIn);
      store.setLinkedFolders(topic, store.linkedFolders(topic).filter((f) => f.path !== text(folder)));
      deps.changed();
    },

    /** Sources copied from files a linked folder holds, to the Trash: only when the user presses the button. */
    async removeCopies(topicIn: unknown): Promise<number> {
      const copies = store.copiesInLinked(topicOf(topicIn));
      for (const path of copies) await deps.trash(path);
      if (copies.length) deps.changed();
      return copies.length;
    },

    file(topicIn: unknown, name: unknown): TopicFileView | null {
      const topic = topicOf(topicIn);
      const found = store.readLinked(topic, text(name));
      if (!found) return null;
      return {
        topic,
        name: linkedName(found.folder, found.rel),
        folder: found.folder,
        rel: found.rel,
        title: found.title,
        text: found.text.slice(0, SHOWN_CHARS),
        cut: found.text.length > SHOWN_CHARS,
        there: existsSync(found.path),
        linksTo: store.linkedNames(store.linksFrom(found.path)),
        linkedFrom: store.linkedNames(store.linksTo(found.path)),
        citedBy: store.citing(topic, linkedName(found.folder, found.rel)),
      };
    },

    /** Finder, not open: the file is the user's, where it always was. */
    revealFile(topicIn: unknown, name: unknown): void {
      const found = store.readLinked(topicOf(topicIn), text(name));
      if (found && existsSync(found.path)) deps.reveal(found.path);
    },

    reveal(topicIn: unknown, item: unknown): void {
      const topic = topicOf(topicIn);
      const it = item && typeof item === "object" ? (item as { kind?: unknown; name?: unknown }) : null;
      const path = !it
        ? store.findTopic(topic)!.dir
        : it.kind === "note"
          ? store.readNote(topic, text(it.name))?.path
          : it.kind === "source"
            ? store.sourcePath(topic, text(it.name))
            : null;
      if (path) deps.reveal(path);
    },

    /** Finder, not open: the original is the user's file, and they look before opening. */
    revealOriginal(topicIn: unknown, name: unknown): void {
      const found = store.readSource(topicOf(topicIn), text(name));
      if (found?.source.original && existsSync(found.source.original)) deps.reveal(found.source.original);
    },

    async deleteTopic(topicIn: unknown): Promise<void> {
      const topic = store.findTopic(text(topicIn));
      if (!topic) return;
      await deps.trash(topic.dir);
      deps.leave(topic.name, ...(topic.temporary ? [true as const] : []));
      deps.changed();
    },

    /** Keep, on the Memory page: a temporary topic becomes the user's, under its name. */
    keepTopic(topicIn: unknown): void {
      store.keepTopic(topicOf(topicIn));
      deps.changed();
    },
  };
}
