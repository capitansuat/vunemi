/**
 * Artefacts: what Vunemi made, in one place — the files it wrote, the drafts it
 * saved, the events it added, the files a page downloaded.
 *
 * The buttons are decided in main, per row: "open" only for documents,
 * pictures and media that are still inside the open folders, so nothing in
 * this list can run a program with one click. Anything else can be shown in
 * Finder, where the user looks before opening.
 */

import { useEffect, useMemo, useState } from "react";
import { Bell, CalendarDays, CornerUpLeft, Download, ExternalLink, Eye, FileText, FolderOpen, Mail, Package } from "lucide-react";
import { useStore } from "../store.js";
import type { Produced } from "@vunemi/agent-core";
import type { ArtefactView } from "../../../shared/ipc.js";
import { clock, groupByDay } from "../lib/time.js";
import { formatDate, t } from "@vunemi/i18n";

type Filter = "all" | "files" | "drafts" | "calendar" | "downloads";

const FILTERS: { key: Filter; match: (item: Produced) => boolean }[] = [
  { key: "all", match: () => true },
  { key: "files", match: (i) => i.kind === "file" },
  { key: "drafts", match: (i) => i.kind === "draft" },
  { key: "calendar", match: (i) => i.kind === "event" || i.kind === "reminder" },
  { key: "downloads", match: (i) => i.kind === "download" },
];

export function ArtefactsView() {
  const [rows, setRows] = useState<ArtefactView[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.listArtefacts().then(setRows);
    return window.vunemi.onArtefacts(setRows);
  }, []);

  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.key === filter)!.match;
    return (rows ?? []).filter((row) => match(row.item));
  }, [rows, filter]);

  const act = async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^.*Error: /, ""));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-8 pb-10">
        <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-fg">
          <Package size={17} className="text-muted" /> {t("app.nav.artefacts")}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {t("artefacts.intro")}
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
                filter === f.key
                  ? "border-line-strong bg-surface-2 text-fg"
                  : "border-line text-muted hover:border-line-strong hover:text-fg"
              }`}
            >
              {t(`artefacts.filters.${f.key}`)}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[12.5px] text-danger">
            {error}
          </p>
        )}

        {rows === null ? (
          <p className="mt-8 text-[13px] text-faint">{t("common.loading")}</p>
        ) : shown.length === 0 ? (
          <p className="mt-8 max-w-[56ch] text-[13px] leading-relaxed text-faint">
            {filter === "all"
              ? t("artefacts.empty")
              : t("artefacts.emptyFilter")}
          </p>
        ) : (
          groupByDay(shown).map(([day, items]) => (
            <section key={day} className="mt-6">
              <h2 className="sticky top-0 bg-bg py-1 text-[11px] font-medium uppercase tracking-wide text-faint">{day}</h2>
              <ul className="mt-1 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {items.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    busy={busy === row.id}
                    onOpen={() => void act(row.id, () => window.vunemi.openArtefact(row.id))}
                    onPreview={() => void act(row.id, () => useStore.getState().showPreview(row.id))}
                    onReveal={() => void act(row.id, () => window.vunemi.revealArtefact(row.id))}
                    onUndo={() => void act(row.id, () => window.vunemi.undoArtefact(row.id))}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  busy,
  onOpen,
  onPreview,
  onReveal,
  onUndo,
}: {
  row: ArtefactView;
  busy: boolean;
  onOpen: () => void;
  onPreview: () => void;
  onReveal: () => void;
  onUndo: () => void;
}) {
  const { icon: Icon, title, detail } = describe(row.item);
  return (
    <li className="flex items-start gap-2.5 px-3.5 py-2.5">
      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-faint">{clock(row.at)}</span>
      <Icon size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[13px] ${row.missing ? "text-muted line-through" : "text-fg"}`} title={title}>
          {title}
        </div>
        <div className="truncate text-[11.5px] text-faint" title={detail}>
          {row.missing ? t("artefacts.missing") : detail}
        </div>
        {row.goal && <div className="truncate text-[11.5px] text-faint">"{row.goal}"</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.canOpen && (
          <Action onClick={onOpen} disabled={busy} icon={ExternalLink}>
            {t("common.open")}
          </Action>
        )}
        {row.canPreview && (
          <Action onClick={onPreview} disabled={busy} icon={Eye}>
            {t("artefacts.preview")}
          </Action>
        )}
        {row.canReveal && (
          <Action onClick={onReveal} disabled={busy} icon={FolderOpen}>
            {t("artefacts.reveal")}
          </Action>
        )}
        {row.canUndo && (
          <Action onClick={onUndo} disabled={busy} icon={CornerUpLeft}>
            {t("common.undo")}
          </Action>
        )}
      </div>
    </li>
  );
}

function Action({
  onClick,
  disabled,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: typeof ExternalLink;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
    >
      <Icon size={11} /> {children}
    </button>
  );
}

/** What a row says, per kind. Paths are shortened to the name and its folder. */
function describe(item: Produced): { icon: typeof FileText; title: string; detail: string } {
  switch (item.kind) {
    case "file":
      return { icon: FileText, title: nameOf(item.path), detail: folderOf(item.path) };
    case "download":
      return { icon: Download, title: nameOf(item.path), detail: folderOf(item.path) };
    case "draft":
      return {
        icon: Mail,
        title: t("artefacts.draft", { subject: item.subject || t("artefacts.noSubject") }),
        detail: `${item.account} → ${item.to.join(", ")}`,
      };
    case "event":
      return {
        icon: CalendarDays,
        title: item.title,
        detail: [when(item.start), item.calendar].filter(Boolean).join(" · "),
      };
    case "reminder":
      return {
        icon: Bell,
        title: item.title,
        detail: [item.due ? when(item.due) : t("artefacts.undated"), item.list].filter(Boolean).join(" · "),
      };
  }
}

function nameOf(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function folderOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  // "/Users/ad/Desktop/x.md" → "Desktop"; deeper paths keep the last two folders.
  const folders = parts.slice(2, -1);
  return folders.length === 0 ? "/" : folders.slice(-2).join(" › ");
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatDate(date, { dateStyle: "medium", timeStyle: "short" });
}
