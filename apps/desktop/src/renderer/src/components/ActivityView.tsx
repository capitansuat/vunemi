import { useEffect, useMemo, useState } from "react";
import { Ban, Check, CornerUpLeft, Hand, History, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ActionClass } from "@vunemi/agent-core";
import type { ActivityEntry } from "../../../shared/ipc.js";
import { actionClassLabel, formatMs, toolLabel } from "../lib/labels.js";
import { clock, groupByDay } from "../lib/time.js";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

type Filter = "all" | "changes" | "page" | "refused";

const FILTERS: { key: Filter; match: (e: ActivityEntry) => boolean }[] = [
  { key: "all", match: () => true },
  { key: "changes", match: (e) => CHANGING.has(e.actionClass) },
  { key: "page", match: (e) => e.tool.startsWith("page_") || e.tool.startsWith("tabs_") },
  { key: "refused", match: (e) => e.status === "refused" || e.status === "error" },
];

const CHANGING = new Set<ActionClass>(["write-local", "destructive", "outbound", "financial"]);

/** Everything the agent has done, kept apart from the conversation. */
export function ActivityView() {
  const { activity, setActivity } = useStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.listActivity().then(setActivity);
    return window.vunemi.onActivity(setActivity);
  }, [setActivity]);

  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.key === filter)!.match;
    return activity.filter(match);
  }, [activity, filter]);

  const days = useMemo(() => groupByDay(shown), [shown]);

  const undo = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await window.vunemi.undoActivity(id);
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
          <History size={17} className="text-muted" /> {t("app.nav.activity")}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {t("activity.intro")}
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
              {t(`activity.filters.${f.key}`)}
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}

        {shown.length === 0 ? (
          <p className="mt-8 text-[13px] text-faint">{t("activity.empty")}</p>
        ) : (
          days.map(([day, entries]) => (
            <section key={day} className="mt-6">
              <h2 className="sticky top-0 bg-bg py-1 text-[11px] font-medium uppercase tracking-wide text-faint">{day}</h2>
              <ul className="mt-1 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {entries.map((e) => (
                  <Row key={e.id} entry={e} busy={busy === e.id} onUndo={() => void undo(e.id)} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ entry, busy, onUndo }: { entry: ActivityEntry; busy: boolean; onUndo: () => void }) {
  return (
    <li className="flex items-start gap-2.5 px-3.5 py-2.5">
      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-faint">{clock(entry.at)}</span>
      <Glyph entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">
          {toolLabel(entry.tool, entry.status === "refused" ? "rejected" : "ok")}
          {entry.preview && <span className="ml-2 text-faint">{entry.preview}</span>}
        </div>
        <div className="truncate text-[11.5px] text-faint">
          {actionClassLabel(entry.actionClass)}
          {entry.durationMs !== undefined && ` · ${formatMs(entry.durationMs)}`}
          {entry.goal && ` · ${entry.goal}`}
        </div>
      </div>
      {entry.undone ? (
        <span className="shrink-0 text-[11.5px] text-muted">{t("activity.undone")}</span>
      ) : (
        entry.undo && (
          <button
            type="button"
            disabled={busy}
            onClick={onUndo}
            title={entry.undo}
            className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <CornerUpLeft size={11} /> {t("common.undo")}
          </button>
        )
      )}
    </li>
  );
}

function Glyph({ entry }: { entry: ActivityEntry }) {
  const cls = "mt-0.5 shrink-0";
  switch (entry.status) {
    case "ok":
      return <Check size={13} className={`${cls} text-ok`} aria-label={t("callStatus.ok")} strokeWidth={2.4} />;
    case "error":
      return <TriangleAlert size={13} className={`${cls} text-danger`} aria-label={t("callStatus.error")} />;
    case "refused":
      return <Ban size={13} className={`${cls} text-muted`} aria-label={t("callStatus.rejected")} />;
    case "waiting-user":
      return <Hand size={13} className={`${cls} text-ember`} aria-label={t("activity.waitingUser")} />;
    default:
      return <LoaderCircle size={13} className={`${cls} animate-spin text-muted`} aria-label={t("callStatus.running")} />;
  }
}
