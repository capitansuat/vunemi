/**
 * What the Memory page asks of the topics: the tree, a note or source to
 * show, search, and the user's own changes. Everything the window sends is
 * checked here: names and titles are looked up in the topics folder, never
 * taken as paths. Errors are in the user's language; the store's own are
 * written for the model.
 */
import { existsSync, statSync } from "node:fs";
import { t } from "@vunemi/i18n";
import type { TopicAddedView, TopicNoteView, TopicSearchView, TopicSourceView, TopicTreeView } from "../../shared/ipc.js";
import type { TopicFound } from "./meaning.js";
import { cleanName, TOPIC_LIMITS, type TopicStore } from "./store.js";
import { addSourceFiles, pickedSources, SOURCE_KINDS, type TopicToolsOptions } from "./tools.js";

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
  leave: (topic: string) => void;
  /** Something changed that the page shows. */
  changed: () => void;
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
    const titles = new Set(store.outline(topic).notes.map((n) => n.title.toLowerCase()));
    return {
      topic,
      title: note.title,
      text: note.text,
      by: note.by,
      sources: note.sources,
      created: note.created,
      updated: note.updated,
      links: note.links.filter((l) => titles.has(l.toLowerCase())),
      missing: note.links.filter((l) => !titles.has(l.toLowerCase())),
      linkedFrom: store.backlinks(topic, note.title),
      stamp: statSync(note.path).mtimeMs,
    };
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
            notes: outline.notes.map((n) => ({ title: n.title, updatedAt: n.mtime })),
            sources: outline.sources.map((s) => ({ name: s.title, updatedAt: s.mtime })),
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
        hits: found.hits.map((h) => ({ kind: h.kind, topic: h.topic, title: h.title, snippet: h.snippet.replace(/\s+/g, " ").trim().slice(0, 300) })),
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
      store.writeNote(topic, { title, text: body, by: "user", sources: old?.sources ?? [] });
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

    async addSources(topicIn: unknown): Promise<TopicAddedView | null> {
      const topic = topicOf(topicIn);
      const picked = await deps.pickFiles(SOURCE_KINDS(deps.convert !== null));
      if (picked.length === 0) return null;
      const room = Math.max(0, TOPIC_LIMITS.sources - store.outline(topic).sources.length);
      const { ok, refused, skipped, left, stopped } = await pickedSources(picked, deps.convert !== null, room);
      const name = (path: string) => path.split("/").pop() ?? path;
      const view: TopicAddedView = { added: [], already: [], failed: refused.map((r) => ({ file: name(r.path), error: r.error })), skipped, left, stopped };
      if (ok.length === 0) return view;
      const { results } = await addSourceFiles(store, deps.convert, topic, ok, AbortSignal.timeout(30 * 60_000));
      for (const r of results) {
        if ("error" in r) view.failed.push({ file: name(r.path), error: r.error });
        else (r.added ? view.added : view.already).push(r.name);
      }
      deps.changed();
      return view;
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
      deps.leave(topic.name);
      deps.changed();
    },
  };
}
