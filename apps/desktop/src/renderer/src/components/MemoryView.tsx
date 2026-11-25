/**
 * Memory: the topics Vunemi keeps notes on (Markdown in a folder of the
 * user's Documents), its general notes about the user, and each project's
 * work notes, in one place. Topics on the left, the chosen note or source on
 * the right; [[links]] between notes open them, and "Linked from" goes back.
 *
 * The files are the user's: every change here is theirs, deletes go to the
 * Trash, and Finder shows where each file is.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookMarked, Check, ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Library, Link2Off, NotebookPen, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { TopicAddedView, TopicCheckView, TopicFileView, TopicNoteView, TopicSearchView, TopicSourceView, TopicTreeView } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { Markdown } from "./Markdown.js";
import { MemorySection } from "./MemorySection.js";
import { ProjectNotes } from "./WorkNotes.js";

type Selected =
  | { kind: "home" }
  | { kind: "topic"; topic: string }
  | { kind: "note"; topic: string; title: string }
  | { kind: "newNote"; topic: string }
  | { kind: "source"; topic: string; name: string }
  | { kind: "file"; topic: string; name: string }
  | { kind: "newTopic" }
  | { kind: "search"; query: string; topic: string | null }
  | { kind: "general" }
  | { kind: "project"; id: string };

/** Notes and sources a topic lists before "Show all". */
const LISTED = 40;
const NOTE_MAX = 4_000;
/** As TOPIC_LIMITS.sources and FOLDER_SCAN_LIMIT in the main process. */
const SOURCE_MAX = 200;
const FOLDER_SCAN_MAX = 20_000;
/** Names an added-files box lists before "N more": a folder can bring hundreds. */
const NAMED = 12;
const someNames = (names: string[]): string =>
  names.length > NAMED ? `${names.slice(0, NAMED).join(", ")}, ${t("topics.page.andMore", { count: names.length - NAMED })}` : names.join(", ");

const message = (err: unknown): string => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const day = (iso: string | number): string => formatDate(new Date(iso), { dateStyle: "medium" });

export function MemoryView() {
  const projects = useStore((s) => s.sessions.projects);
  const [tree, setTree] = useState<TopicTreeView | null>(null);
  const [selected, setSelected] = useState<Selected>(() => {
    const focus = useStore.getState().memoryFocus;
    if (!focus) return { kind: "home" };
    useStore.setState({ memoryFocus: null });
    return focus.kind === "general" ? { kind: "general" } : { kind: "project", id: focus.id };
  });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  /** Bumped when a topic changes on disk: what is shown is read again. */
  const [version, setVersion] = useState(0);

  // Another view may send the user here again while the page is open (a project's "Notes").
  const focus = useStore((s) => s.memoryFocus);
  useEffect(() => {
    if (!focus) return;
    useStore.setState({ memoryFocus: null });
    setSelected(focus.kind === "general" ? { kind: "general" } : { kind: "project", id: focus.id });
  }, [focus]);

  const load = useCallback(() => {
    void window.vunemi.topicsTree().then(setTree).catch(() => setTree({ root: "", topics: [], canConvert: false }));
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    load();
    return window.vunemi.onTopicsChanged(load);
  }, [load]);

  const select = (next: Selected) => {
    setSelected(next);
    if ("topic" in next && next.topic) setOpen((prev) => new Set(prev).add(next.topic!));
  };
  const toggle = (topic: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(topic)) next.add(topic);
      return next;
    });

  const topicNames = useMemo(() => new Set((tree?.topics ?? []).map((tp) => tp.name)), [tree]);
  // A topic that went (deleted in Finder, say) leaves nothing selected in it.
  useEffect(() => {
    if (tree && "topic" in selected && selected.topic && !topicNames.has(selected.topic)) setSelected({ kind: "home" });
  }, [tree, topicNames, selected]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="scroll-thin w-[270px] shrink-0 overflow-y-auto border-r border-line px-3 pt-5 pb-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) select({ kind: "search", query: query.trim(), topic: null });
          }}
        >
          <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("topics.page.search")}
              aria-label={t("topics.page.search")}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
          </label>
        </form>

        <div className="mt-5 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{t("topics.page.topics")}</h2>
          <button type="button" onClick={() => select({ kind: "newTopic" })} title={t("topics.page.newTopic")} aria-label={t("topics.page.newTopic")} className="grid size-6 place-items-center rounded text-faint hover:bg-surface-2 hover:text-fg">
            <Plus size={14} />
          </button>
        </div>
        {tree && tree.topics.length === 0 && <p className="mt-1.5 px-1 text-[12px] text-faint">{t("topics.page.noTopics")}</p>}
        <ul className="mt-1 space-y-0.5">
          {(tree?.topics ?? []).map((topic) => (
            <TopicBranch key={topic.name} topic={topic} open={open.has(topic.name)} selected={selected} onToggle={() => toggle(topic.name)} onSelect={select} />
          ))}
        </ul>

        <h2 className="mt-6 px-1 text-[11px] font-medium uppercase tracking-wide text-faint">{t("topics.page.more")}</h2>
        <ul className="mt-1 space-y-0.5">
          <li>
            <NavRow active={selected.kind === "general"} icon={<BookMarked size={13} />} onClick={() => select({ kind: "general" })}>
              {t("topics.page.general")}
            </NavRow>
          </li>
          {projects.map((project) => (
            <li key={project.id}>
              <NavRow active={selected.kind === "project" && selected.id === project.id} icon={<NotebookPen size={13} />} onClick={() => select({ kind: "project", id: project.id })}>
                {t("topics.page.projectNotes", { name: project.name })}
              </NavRow>
            </li>
          ))}
        </ul>
      </aside>

      <section className="scroll-thin min-w-0 flex-1 overflow-y-auto px-8 pt-8 pb-12">
        {selected.kind === "home" && <Home tree={tree} onNew={() => select({ kind: "newTopic" })} />}
        {selected.kind === "newTopic" && (
          <NewTopic
            onMade={async (name) => {
              // The tree first: with the old one the new topic would count as gone and the page go home.
              const fresh = await window.vunemi.topicsTree();
              setTree(fresh);
              select({ kind: "topic", topic: fresh.topics.find((tp) => tp.name.toLowerCase() === name.toLowerCase())?.name ?? name });
            }}
            onCancel={() => select({ kind: "home" })}
          />
        )}
        {selected.kind === "topic" && tree && (
          <TopicPanel key={selected.topic} topic={tree.topics.find((tp) => tp.name === selected.topic)} canConvert={tree.canConvert} onSelect={select} />
        )}
        {selected.kind === "note" && <NotePanel key={`${selected.topic}/${selected.title}`} topic={selected.topic} title={selected.title} version={version} tree={tree} onSelect={select} />}
        {selected.kind === "newNote" && (
          <NoteEditor topic={selected.topic} note={null} onSaved={(note) => select({ kind: "note", topic: note.topic, title: note.title })} onCancel={() => select({ kind: "topic", topic: selected.topic })} />
        )}
        {selected.kind === "source" && <SourcePanel key={`${selected.topic}/${selected.name}`} topic={selected.topic} name={selected.name} version={version} onSelect={select} />}
        {selected.kind === "file" && <FilePanel key={`${selected.topic}/${selected.name}`} topic={selected.topic} name={selected.name} version={version} onSelect={select} />}
        {selected.kind === "search" && <SearchPanel key={`${selected.topic}/${selected.query}`} query={selected.query} topic={selected.topic} version={version} onSelect={select} />}
        {selected.kind === "general" && <MemorySection title={t("topics.page.general")} />}
        {selected.kind === "project" && <ProjectNotes projectId={selected.id} />}
      </section>
    </div>
  );
}

function NavRow({ active, icon, onClick, children, depth = 0 }: { active: boolean; icon: ReactNode; onClick: () => void; children: ReactNode; depth?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-[12.5px] ${active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
    >
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function TopicBranch({
  topic,
  open,
  selected,
  onToggle,
  onSelect,
}: {
  topic: TopicTreeView["topics"][number];
  open: boolean;
  selected: Selected;
  onToggle: () => void;
  onSelect: (s: Selected) => void;
}) {
  const [all, setAll] = useState(false);
  const notes = all ? topic.notes : topic.notes.slice(0, LISTED);
  const sources = all ? topic.sources : topic.sources.slice(0, LISTED);
  const here = "topic" in selected && selected.topic === topic.name;
  return (
    <li>
      <div className={`flex items-center rounded-md ${selected.kind === "topic" && here ? "bg-surface-2" : "hover:bg-surface-2"}`}>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={topic.name} className="grid size-6 shrink-0 place-items-center text-faint">
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <button type="button" onClick={() => onSelect({ kind: "topic", topic: topic.name })} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] text-fg">
          <span className="truncate">{topic.name}</span>
          {topic.temporary && <span className="shrink-0 rounded border border-line px-1 text-[10.5px] text-faint">{t("topics.page.temporary")}</span>}
        </button>
      </div>
      {open && (
        <ul className="mb-1 space-y-0.5">
          {notes.map((n) => (
            <li key={`n:${n.title}`}>
              <NavRow depth={1} active={selected.kind === "note" && here && selected.title === n.title} icon={<FileText size={12} />} onClick={() => onSelect({ kind: "note", topic: topic.name, title: n.title })}>
                {n.title}
              </NavRow>
            </li>
          ))}
          {sources.length > 0 && <li className="px-2 pt-1.5 pl-[22px] text-[10.5px] uppercase tracking-wide text-faint">{t("topics.page.sources")}</li>}
          {sources.map((s) => (
            <li key={`s:${s.name}`}>
              <NavRow depth={1} active={selected.kind === "source" && here && selected.name === s.name} icon={<Library size={12} />} onClick={() => onSelect({ kind: "source", topic: topic.name, name: s.name })}>
                {s.name}
              </NavRow>
            </li>
          ))}
          {topic.folders.length > 0 && <li className="px-2 pt-1.5 pl-[22px] text-[10.5px] uppercase tracking-wide text-faint">{t("topics.page.folders")}</li>}
          {topic.folders.map((f) => (
            <li key={`f:${f.path}`}>
              <NavRow depth={1} active={false} icon={<Folder size={12} />} onClick={() => onSelect({ kind: "topic", topic: topic.name })}>
                {f.path.split("/").pop()}
              </NavRow>
            </li>
          ))}
          {!all && (topic.notes.length > LISTED || topic.sources.length > LISTED) && (
            <li>
              <button type="button" onClick={() => setAll(true)} className="ml-[22px] py-1 text-[11.5px] text-muted underline decoration-dotted hover:text-fg">
                {t("topics.page.showAll")}
              </button>
            </li>
          )}
          {topic.notes.length === 0 && topic.sources.length === 0 && topic.folders.length === 0 && <li className="py-1 pl-[30px] text-[11.5px] text-faint">{t("topics.page.emptyTopic")}</li>}
        </ul>
      )}
    </li>
  );
}

function Button({ onClick, icon, children, danger, disabled }: { onClick: () => void; icon?: ReactNode; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${danger ? "border-danger/40 text-danger hover:bg-danger/5" : "border-line-strong text-fg hover:bg-surface-2"}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** A delete that asks once more, on the spot. */
function DeleteButton({ label, confirm, onDelete }: { label: string; confirm: string; onDelete: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <Button onClick={() => setAsking(true)} icon={<Trash2 size={12} />}>{label}</Button>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-muted">{confirm}</span>
      <Button danger disabled={busy} onClick={() => { setBusy(true); void onDelete().finally(() => setBusy(false)); }} icon={<Trash2 size={12} />}>
        {t("topics.page.toTrash")}
      </Button>
      <Button onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
    </span>
  );
}

/** An action that asks once more, on the spot, in its own words. */
function ConfirmButton({ label, confirm, icon, onConfirm }: { label: string; confirm: string; icon: ReactNode; onConfirm: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <Button onClick={() => setAsking(true)} icon={icon}>{label}</Button>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-muted">{confirm}</span>
      <Button disabled={busy} onClick={() => { setBusy(true); void onConfirm().finally(() => { setBusy(false); setAsking(false); }); }} icon={icon}>
        {label}
      </Button>
      <Button onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
    </span>
  );
}

function Home({ tree, onNew }: { tree: TopicTreeView | null; onNew: () => void }) {
  return (
    <div className="max-w-[620px]">
      <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-fg">
        <BookMarked size={17} className="text-muted" /> {t("app.nav.memory")}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("topics.page.intro")}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("topics.page.how")}</p>
      {tree?.root && (
        <p className="mt-3 text-[12px] text-faint">
          {t("topics.page.folder")}: <span className="selectable font-mono">{tree.root}</span>
        </p>
      )}
      <div className="mt-5">
        <Button onClick={onNew} icon={<FolderPlus size={13} />}>{t("topics.page.newTopic")}</Button>
      </div>
    </div>
  );
}

function NewTopic({ onMade, onCancel }: { onMade: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = () => {
    setBusy(true);
    setError(null);
    window.vunemi
      .topicsCreate(name, about)
      .then(() => onMade(name.replace(/\s+/g, " ").trim()))
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="max-w-[560px]" onSubmit={(e) => { e.preventDefault(); make(); }}>
      <h1 className="text-[17px] font-semibold text-fg">{t("topics.page.newTopic")}</h1>
      <label className="mt-4 block text-[12px] text-muted">
        {t("topics.page.name")}
        <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-fg focus:border-ember focus:outline-none" />
      </label>
      <label className="mt-3 block text-[12px] text-muted">
        {t("topics.page.about")}
        <textarea value={about} maxLength={1000} rows={3} onChange={(e) => setAbout(e.target.value)} placeholder={t("topics.page.aboutHint")} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-fg placeholder:text-faint focus:border-ember focus:outline-none" />
      </label>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg disabled:opacity-50">{t("topics.page.create")}</button>
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

export function TopicPanel({ topic, canConvert, onSelect }: { topic: TopicTreeView["topics"][number] | undefined; canConvert: boolean; onSelect: (s: Selected) => void }) {
  const [editing, setEditing] = useState(false);
  const [about, setAbout] = useState(topic?.about ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<TopicAddedView | null>(null);
  if (!topic) return null;
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work().catch((err: unknown) => setError(message(err))).finally(() => setBusy(false));
  };
  return (
    <div className="max-w-[680px]">
      <h1 className="text-[17px] font-semibold text-fg">{topic.name}</h1>
      {topic.temporary && (
        <p className="mt-1 text-[12.5px] text-muted">
          <span className="mr-1.5 rounded border border-line px-1 text-[11px] text-faint">{t("topics.page.temporary")}</span>
          {t("topics.page.temporaryWhy")}
        </p>
      )}
      <p className="mt-1 text-[12px] text-faint">
        {t("topics.page.noteCount", { count: topic.notes.length })} · {t("topics.page.sourceCount", { count: topic.sources.length })} · {t("topics.page.changedOn", { date: day(topic.updatedAt) })}
      </p>
      {editing ? (
        <div className="mt-3">
          <textarea autoFocus value={about} maxLength={1000} rows={3} onChange={(e) => setAbout(e.target.value)} aria-label={t("topics.page.about")} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-fg focus:border-ember focus:outline-none" />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => window.vunemi.topicsSetAbout(topic.name, about).then(() => setEditing(false)))} className="rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg disabled:opacity-50">{t("common.save")}</button>
            <Button onClick={() => { setAbout(topic.about); setEditing(false); }}>{t("common.cancel")}</Button>
          </div>
        </div>
      ) : (
        <p className="selectable mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-muted">{topic.about}</p>
      )}
      <p className="mt-2 text-[12px] text-faint">{t("topics.page.aboutWhy")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => onSelect({ kind: "newNote", topic: topic.name })} icon={<FilePlus2 size={13} />}>{t("topics.page.newNote")}</Button>
        <Button disabled={busy} onClick={() => run(() => window.vunemi.topicsAddSources(topic.name).then((r) => setAdded(r)))} icon={<Library size={13} />}>{t("topics.page.addSources")}</Button>
        {!editing && <Button onClick={() => setEditing(true)} icon={<Pencil size={12} />}>{t("topics.page.editAbout")}</Button>}
        <Button onClick={() => void window.vunemi.topicsReveal(topic.name, null)} icon={<FolderOpen size={13} />}>{t("topics.page.reveal")}</Button>
        {topic.temporary && <Button disabled={busy} onClick={() => run(() => window.vunemi.topicsKeep(topic.name))} icon={<Check size={13} />}>{t("topics.page.keepTopic")}</Button>}
        <DeleteButton label={t("topics.page.deleteTopic")} confirm={t("topics.page.deleteTopicConfirm", { topic: topic.name })} onDelete={() => window.vunemi.topicsDelete(topic.name).catch((err: unknown) => setError(message(err)))} />
      </div>
      {!canConvert && <p className="mt-2 text-[12px] text-faint">{t("topics.page.textOnly")}</p>}
      {busy && <p className="mt-3 text-[12px] text-muted">{t("topics.page.adding")}</p>}
      {added && (
        <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-[12.5px]">
          {added.linked.map((l) => (
            <p key={`l:${l.folder}`} className="text-fg">{t("topics.page.linked", { count: l.files, folder: l.folder.split("/").pop() ?? l.folder })}</p>
          ))}
          {added.added.length > 0 && <p className="text-fg">{t("topics.page.added", { names: someNames(added.added) })}</p>}
          {added.already.length > 0 && <p className="text-muted">{t("topics.page.already", { names: someNames(added.already) })}</p>}
          {added.failed.slice(0, NAMED).map((f, i) => (
            <p key={`${i}:${f.file}`} className="text-danger">{f.file}: {f.error}</p>
          ))}
          {added.failed.length > NAMED && <p className="text-danger">{t("topics.page.andMore", { count: added.failed.length - NAMED })}</p>}
          {added.skipped > 0 && <p className="text-muted">{t("topics.page.skipped", { count: added.skipped })}</p>}
          {added.copies > 0 && <p className="text-muted">{t("topics.page.copies", { count: added.copies })}</p>}
          {added.left > 0 && <p className="text-muted">{t("topics.page.left", { count: added.left, max: SOURCE_MAX })}</p>}
          {added.stopped && <p className="text-muted">{t("topics.page.stopped", { max: FOLDER_SCAN_MAX.toLocaleString() })}</p>}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
      {topic.copies > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 text-[12.5px] text-muted">
          <span>{t("topics.page.copiesOffer", { count: topic.copies })}</span>
          <Button disabled={busy} onClick={() => run(() => window.vunemi.topicsRemoveCopies(topic.name))} icon={<Trash2 size={12} />}>{t("topics.page.removeCopies")}</Button>
        </div>
      )}
      {topic.folders.length > 0 && (
        <section className="mt-7">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{t("topics.page.folders")}</h2>
          <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line bg-surface">
            {topic.folders.map((f) => (
              <li key={f.path} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] text-fg">
                <Folder size={13} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="selectable block truncate font-mono text-[12px]">{f.path}</span>
                  <span className="block text-[11.5px] text-faint">
                    {f.state === "missing" ? t("topics.page.folderMissing") : f.state === "refused" ? t("topics.page.folderRefused") : f.files > 0 && f.indexed < f.files ? t("topics.page.indexing", { indexed: f.indexed.toLocaleString(), files: f.files.toLocaleString() }) : t("topics.page.filesCount", { count: f.indexed })}
                  </span>
                </span>
                <ConfirmButton label={t("topics.page.unlink")} confirm={t("topics.page.unlinkConfirm", { folder: f.path.split("/").pop() ?? f.path })} icon={<Link2Off size={12} />} onConfirm={() => window.vunemi.topicsUnlink(topic.name, f.path).catch((err: unknown) => setError(message(err)))} />
                {f.state === "ok" && f.subfolders.length > 0 && (
                  <MeaningSwitches folder={f} onSet={(sub, on) => run(() => window.vunemi.topicsSetMeaning(topic.name, f.path, sub, on))} busy={busy} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {topic.checks.length > 0 && <NeedsLook topic={topic.name} checks={topic.checks} onSelect={onSelect} />}
      {topic.notes.length > 0 && (
        <section className="mt-7">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{t("topics.page.notes")}</h2>
          <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line bg-surface">
            {topic.notes.slice(0, LISTED).map((n) => (
              <li key={n.title}>
                <button type="button" onClick={() => onSelect({ kind: "note", topic: topic.name, title: n.title })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-fg hover:bg-surface-2">
                  <FileText size={13} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  <span className="shrink-0 text-[11px] text-faint">{day(n.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A note's sources: those that are sources of the topic open; "conversation: …" and others are words. */
function Origins({ note, sources, onSelect }: { note: TopicNoteView; sources: ReadonlySet<string>; onSelect: (s: Selected) => void }) {
  if (note.sources.length === 0) return null;
  return (
    <p className="mt-1 text-[12px] text-faint">
      {t("topics.page.from")}:{" "}
      {note.sources.map((s, i) => (
        <span key={s}>
          {i > 0 && ", "}
          {sources.has(s.toLowerCase()) ? (
            <button type="button" onClick={() => onSelect({ kind: "source", topic: note.topic, name: s })} className="underline decoration-dotted hover:text-fg">{s}</button>
          ) : (
            s
          )}
        </span>
      ))}
    </p>
  );
}

function NotePanel({ topic, title, version, tree, onSelect }: { topic: string; title: string; version: number; tree: TopicTreeView | null; onSelect: (s: Selected) => void }) {
  const [note, setNote] = useState<TopicNoteView | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // While the user edits, a change on disk doesn't replace their text; saving says it changed.
    if (editing) return;
    let stale = false;
    window.vunemi
      .topicsNote(topic, title)
      .then((n) => !stale && setNote(n))
      .catch((err: unknown) => !stale && setError(message(err)));
    return () => {
      stale = true;
    };
  }, [topic, title, version, editing]);
  const sources = useMemo(() => new Set((tree?.topics.find((tp) => tp.name === topic)?.sources ?? []).map((s) => s.name.toLowerCase())), [tree, topic]);
  const titles = useMemo(() => new Map((note?.links ?? []).map((l) => [l.toLowerCase(), l])), [note]);
  const files = useMemo(() => new Map((note?.files ?? []).map((f) => [f.link.toLowerCase(), f.name])), [note]);

  if (note === undefined) return error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null;
  if (note === null) return <p className="text-[13px] text-faint">{t("topics.page.noteGone")}</p>;
  if (editing) {
    return <NoteEditor topic={topic} note={note} onSaved={(saved) => { setEditing(false); if (saved.title !== note.title) onSelect({ kind: "note", topic, title: saved.title }); else setNote(saved); }} onCancel={() => setEditing(false)} />;
  }
  return (
    <article className="max-w-[680px]">
      <p className="text-[12px] text-faint">
        <button type="button" onClick={() => onSelect({ kind: "topic", topic })} className="hover:text-fg">{topic}</button>
      </p>
      <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-fg">{note.title}</h1>
      <p className="mt-1 text-[12px] text-faint">
        {t(note.by === "vunemi" ? "topics.page.byVunemi" : "topics.page.byYou")} · {t("topics.page.changedOn", { date: day(note.updated) })}
      </p>
      {note.aliases.length > 0 && <p className="selectable mt-1 text-[12px] text-faint">{t("topics.page.aliases")}: {note.aliases.join(", ")}</p>}
      <Origins note={note} sources={sources} onSelect={onSelect} />
      {note.stale.length > 0 && (
        <p role="status" className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {t("topics.page.stale", { count: note.stale.length })}: {note.stale.join(", ")}
        </p>
      )}
      <div className="mt-5">
        <Markdown
          text={note.text}
          wiki={{
            exists: (linked) => titles.has(linked.toLowerCase()) || files.has(linked.toLowerCase()),
            open: (linked) => {
              const file = files.get(linked.toLowerCase());
              onSelect(file ? { kind: "file", topic, name: file } : { kind: "note", topic, title: titles.get(linked.toLowerCase()) ?? linked });
            },
          }}
        />
      </div>
      {/* A linked file is named with its folder; a source has no slash in its name. */}
      <FileLinks label={t("topics.page.cites")} names={[...new Set(note.cites.map((c) => c.name))]} onOpen={(name) => onSelect(name.includes("/") ? { kind: "file", topic, name } : { kind: "source", topic, name })} />
      <FileLinks label={t("topics.page.linkedFrom")} names={note.linkedFrom} onOpen={(title) => onSelect({ kind: "note", topic, title })} />
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={() => setEditing(true)} icon={<Pencil size={12} />}>{t("topics.page.edit")}</Button>
        <Button onClick={() => void window.vunemi.topicsReveal(topic, { kind: "note", name: note.title })} icon={<FolderOpen size={13} />}>{t("topics.page.reveal")}</Button>
        <DeleteButton
          label={t("topics.page.delete")}
          confirm={t("topics.page.deleteNoteConfirm", { title: note.title })}
          onDelete={() => window.vunemi.topicsDeleteNote(topic, note.title).then(() => onSelect({ kind: "topic", topic })).catch((err: unknown) => setError(message(err)))}
        />
      </div>
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    </article>
  );
}

function NoteEditor({ topic, note, onSaved, onCancel }: { topic: string; note: TopicNoteView | null; onSaved: (note: TopicNoteView) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [text, setText] = useState(note?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    setError(null);
    window.vunemi
      .topicsSaveNote(topic, { title, text }, note && { title: note.title, stamp: note.stamp })
      .then(onSaved)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="max-w-[680px]" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <p className="text-[12px] text-faint">{topic}</p>
      <input
        autoFocus={!note}
        value={title}
        maxLength={80}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("topics.page.title")}
        aria-label={t("topics.page.title")}
        className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] font-semibold text-fg placeholder:font-normal placeholder:text-faint focus:border-ember focus:outline-none"
      />
      <textarea
        autoFocus={!!note}
        value={text}
        maxLength={NOTE_MAX}
        rows={16}
        onChange={(e) => setText(e.target.value)}
        aria-label={t("topics.page.text")}
        className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg focus:border-ember focus:outline-none"
      />
      <p className="mt-1 text-[11.5px] text-faint">{t("topics.page.editHint", { count: text.length, max: NOTE_MAX })}</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy || !title.trim() || !text.trim()} className="rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg disabled:opacity-50">{t("common.save")}</button>
        <Button onClick={onCancel} icon={<X size={12} />}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

function SourcePanel({ topic, name, version, onSelect }: { topic: string; name: string; version: number; onSelect: (s: Selected) => void }) {
  const [source, setSource] = useState<TopicSourceView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    window.vunemi
      .topicsSource(topic, name)
      .then((s) => !stale && setSource(s))
      .catch((err: unknown) => !stale && setError(message(err)));
    return () => {
      stale = true;
    };
  }, [topic, name, version]);
  if (source === undefined) return error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null;
  if (source === null) return <p className="text-[13px] text-faint">{t("topics.page.sourceGone")}</p>;
  const original = source.original.split("/").pop() ?? source.original;
  return (
    <article className="max-w-[760px]">
      <p className="text-[12px] text-faint">
        <button type="button" onClick={() => onSelect({ kind: "topic", topic })} className="hover:text-fg">{topic}</button> · {t("topics.page.source")}
      </p>
      <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-fg">{source.name}</h1>
      <p className="mt-1 text-[12px] text-faint">
        {t("topics.page.madeFrom", { file: original || "—", date: day(source.added) })} · {t("topics.page.chars", { count: source.chars.toLocaleString() })}
        {source.original && !source.originalThere && <> · {t("topics.page.originalGone")}</>}
      </p>
      <p className="mt-1 text-[12px] text-faint">{t("topics.page.sourceWhy")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {source.originalThere && <Button onClick={() => void window.vunemi.topicsRevealOriginal(topic, source.name)} icon={<FolderOpen size={13} />}>{t("topics.page.revealOriginal")}</Button>}
        <Button onClick={() => void window.vunemi.topicsReveal(topic, { kind: "source", name: source.name })} icon={<FolderOpen size={13} />}>{t("topics.page.reveal")}</Button>
        <DeleteButton
          label={t("topics.page.delete")}
          confirm={t("topics.page.deleteSourceConfirm", { name: source.name })}
          onDelete={() => window.vunemi.topicsDeleteSource(topic, source.name).then(() => onSelect({ kind: "topic", topic })).catch((err: unknown) => setError(message(err)))}
        />
      </div>
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
      <div className="mt-6 border-t border-line pt-5">
        <Markdown text={source.text} />
        {source.cut && <p className="mt-4 text-[12px] text-faint">{t("topics.page.cut")}</p>}
      </div>
    </article>
  );
}

/** A file of a linked folder: read where it is, never changed from here. */
function FilePanel({ topic, name, version, onSelect }: { topic: string; name: string; version: number; onSelect: (s: Selected) => void }) {
  const [file, setFile] = useState<TopicFileView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    window.vunemi
      .topicsFile(topic, name)
      .then((f) => !stale && setFile(f))
      .catch((err: unknown) => !stale && setError(message(err)));
    return () => {
      stale = true;
    };
  }, [topic, name, version]);
  if (file === undefined) return error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null;
  if (file === null) return <p className="text-[13px] text-faint">{t("topics.page.sourceGone")}</p>;
  return (
    <article className="max-w-[760px]">
      <p className="text-[12px] text-faint">
        <button type="button" onClick={() => onSelect({ kind: "topic", topic })} className="hover:text-fg">{topic}</button> · {t("topics.page.linkedFile")}
      </p>
      <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight text-fg">{file.title}</h1>
      <p className="selectable mt-1 font-mono text-[12px] text-faint">{file.name}</p>
      <p className="mt-1 text-[12px] text-faint">{t("topics.page.linkedWhy")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {file.there && <Button onClick={() => void window.vunemi.topicsRevealFile(topic, file.name)} icon={<FolderOpen size={13} />}>{t("topics.page.revealOriginal")}</Button>}
      </div>
      {!file.there && <p className="mt-3 text-[12px] text-faint">{t("topics.page.originalGone")}</p>}
      <div className="mt-6 border-t border-line pt-5">
        <Markdown text={file.text} />
        {file.cut && <p className="mt-4 text-[12px] text-faint">{t("topics.page.cut")}</p>}
      </div>
      <FileLinks label={t("topics.page.linksTo")} names={file.linksTo} onOpen={(n) => onSelect({ kind: "file", topic, name: n })} />
      <FileLinks label={t("topics.page.linkedFrom")} names={file.linkedFrom} onOpen={(n) => onSelect({ kind: "file", topic, name: n })} />
      <FileLinks label={t("topics.page.citedBy")} names={file.citedBy} onOpen={(title) => onSelect({ kind: "note", topic, title })} />
    </article>
  );
}

/**
 * Which subfolders of a linked folder are searched by meaning: the top
 * level and small ones by default, large ones start off; word search
 * covers them all either way.
 */
function MeaningSwitches({ folder, onSet, busy }: { folder: TopicTreeView["topics"][number]["folders"][number]; onSet: (subfolder: string, on: boolean) => void; busy: boolean }) {
  const off = folder.subfolders.filter((s) => !s.meaning).reduce((sum, s) => sum + s.files, 0);
  return (
    <details className="basis-full pl-5 text-[12px] text-muted">
      <summary className="cursor-default select-none text-faint hover:text-fg">
        {t("topics.page.meaningFor")}
        {off > 0 && <span> · {t("topics.page.meaningOff", { count: off })}</span>}
      </summary>
      <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
        {folder.subfolders.map((s) => (
          <li key={s.name}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.meaning} disabled={busy} onChange={(e) => onSet(s.name, e.target.checked)} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">{s.name}</span>
              <span className="shrink-0 text-[11px] text-faint">{t("topics.page.filesCount", { count: s.files })}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** What the last check found: a page to open where there is one; nothing is changed for the user. */
function NeedsLook({ topic, checks, onSelect }: { topic: string; checks: TopicCheckView[]; onSelect: (s: Selected) => void }) {
  const line = (c: TopicCheckView): { text: string; page: string | null } => {
    switch (c.kind) {
      case "deadLink":
        return { text: t("topics.check.deadLink", { page: c.page, link: c.link }), page: c.page };
      case "orphan":
        return { text: t("topics.check.orphan", { page: c.page }), page: c.page };
      case "samePage":
        return { text: t("topics.check.samePage", { pages: c.pages.join(", ") }), page: c.pages[0] ?? null };
      case "stale":
        return { text: t("topics.check.stale", { page: c.page, files: c.files.join(", ") }), page: c.page };
      case "folder":
        return { text: t("topics.check.folder", { folder: c.path.split("/").pop() ?? c.path, why: t(c.state === "missing" ? "topics.page.folderMissing" : "topics.page.folderRefused") }), page: null };
    }
  };
  return (
    <section className="mt-7">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{t("topics.page.needsLook")}</h2>
      <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line bg-surface">
        {checks.map((c, i) => {
          const { text, page } = line(c);
          return (
            <li key={i}>
              {page ? (
                <button type="button" onClick={() => onSelect({ kind: "note", topic, title: page })} className="w-full px-3 py-2 text-left text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg">{text}</button>
              ) : (
                <p className="px-3 py-2 text-[12.5px] text-muted">{text}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A row of names to open: a linked file's links, or the pages citing it. */
function FileLinks({ label, names, onOpen }: { label: string; names: string[]; onOpen: (name: string) => void }) {
  if (names.length === 0) return null;
  return (
    <section className="mt-7 border-t border-line pt-3">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</h2>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li key={name}>
            <button type="button" onClick={() => onOpen(name)} className="rounded-md border border-line px-2 py-0.5 text-[12px] text-muted hover:bg-surface-2 hover:text-fg">{name}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SearchPanel({ query, topic, version, onSelect }: { query: string; topic: string | null; version: number; onSelect: (s: Selected) => void }) {
  const [found, setFound] = useState<TopicSearchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setFound(null);
    window.vunemi
      .topicsSearch(query, topic)
      .then((f) => !stale && setFound(f))
      .catch((err: unknown) => !stale && setError(message(err)));
    return () => {
      stale = true;
    };
  }, [query, topic, version]);
  return (
    <div className="max-w-[680px]">
      <h1 className="text-[17px] font-semibold text-fg">{t("topics.page.searchFor", { query })}</h1>
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
      {found === null && !error && <p className="mt-3 text-[13px] text-faint">{t("common.loading")}</p>}
      {found && (
        <>
          <p className="mt-1 text-[12px] text-faint">
            {found.byMeaning ? t("topics.page.byMeaning") : t("topics.page.byWords")}
            {found.pending > 0 && <> · {t("topics.page.pending", { count: found.pending })}</>}
          </p>
          {found.hits.length === 0 ? (
            <p className="mt-4 text-[13px] text-faint">{t("topics.page.noHits")}</p>
          ) : (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
              {found.hits.map((h) => (
                <li key={`${h.topic}/${h.kind}/${h.title}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(h.kind === "note" ? { kind: "note", topic: h.topic, title: h.title } : h.kind === "file" ? { kind: "file", topic: h.topic, name: h.name ?? h.title } : { kind: "source", topic: h.topic, name: h.title })}
                    className="block w-full px-3.5 py-2.5 text-left hover:bg-surface-2"
                  >
                    <span className="flex items-center gap-2 text-[13px] text-fg">
                      {h.kind === "note" ? <FileText size={13} className="shrink-0 text-faint" /> : h.kind === "file" ? <Folder size={13} className="shrink-0 text-faint" /> : <Library size={13} className="shrink-0 text-faint" />}
                      <span className="truncate">{h.title}</span>
                      <span className="shrink-0 text-[11px] text-faint">{h.topic}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">{h.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
