/**
 * The summary a scheduled task is set up from. Its lines come from the main
 * process, made from what the task's runs may use: this shows them and
 * decides nothing.
 */

import { useId, useState } from "react";
import { Check, Clock, Play, X } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { SetupView, ShortcutInstallView, ShortcutRecipeView } from "../../../shared/ipc.js";
import { useStore } from "../store.js";

/** Monday first; 0 is Sunday, as the schedule counts them. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
// 3 Jan 2021 is a Sunday.
const dayName = (day: number) => formatDate(new Date(2021, 0, 3 + day), { weekday: "short" });

/** The lines of a summary: what it does with a tick, what it never does with a cross. */
function Lines({ lines }: { lines: { does: boolean; text: string }[] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {lines.map((line) => (
        <li key={line.text} className="flex items-start gap-2 text-[13px] text-fg">
          {line.does ? (
            <Check size={14} role="img" aria-label={t("automations.page.does")} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <X size={14} role="img" aria-label={t("automations.page.never")} className="mt-0.5 shrink-0 text-muted" />
          )}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a shortcut would do, before it is built: its steps and its lines,
 * both made from its blocks in the main process. Set up builds it and opens
 * it in Shortcuts; adding it is the user's answer there, and this waits for
 * it.
 */
export function ShortcutSummary({ view, onClose }: { view: ShortcutRecipeView; onClose: () => void }) {
  const [working, setWorking] = useState(false);
  const [built, setBuilt] = useState<ShortcutInstallView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = built?.state === "added" || built?.state === "exists";

  const install = () => {
    setWorking(true);
    setBuilt(null);
    setError(null);
    window.vunemi
      .installShortcut(view.id)
      .then(setBuilt, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setWorking(false));
  };

  return (
    <div className="mx-auto max-w-[560px]">
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">{view.title}</h1>
      <p className="mt-1 text-[13px] text-muted">{view.body}</p>
      <p className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-fg">
        <Play size={13} className="text-muted" /> {t("automations.shortcut.when")}
      </p>

      <h2 className="mt-6 text-[12px] font-medium text-muted">{t("automations.shortcut.steps")}</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-fg">
        {view.steps.map((step, i) => (
          <li key={i} className="selectable">{step}</li>
        ))}
      </ol>

      <h2 className="mt-6 text-[12px] font-medium text-muted">{t("automations.page.summary")}</h2>
      <Lines lines={view.lines} />
      <p className="mt-4 text-[12.5px] leading-snug text-muted">{t("automations.shortcut.confirm")}</p>

      <div role="status" className="mt-4 text-[12.5px]">
        {working && <p className="text-muted">{t("automations.shortcut.working")}</p>}
        {built?.state === "added" && <p className="text-ok">{t("automations.shortcut.added", { name: built.name })}</p>}
        {built?.state === "exists" && <p className="text-muted">{t("automations.shortcut.exists", { name: built.name })}</p>}
        {built?.state === "notAdded" && <p className="text-warn">{t("automations.shortcut.notAdded", { name: built.name })}</p>}
        {built?.state === "failed" && <p className="text-warn">{t("automations.shortcut.failed", { reason: built.reason })}</p>}
      </div>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {!done && (
          <button
            type="button"
            disabled={working}
            onClick={install}
            className="rounded-lg bg-ember px-3.5 py-1.5 text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:bg-surface-3 disabled:text-faint"
          >
            {t("automations.page.install")}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
          {done ? t("common.close") : t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * What a scheduled task would do, before it is set up: nothing is scheduled
 * until Set up is pressed. The same summary for a recipe of the gallery and
 * for a task the model proposes in chat.
 */
export function SetupSummary({
  view,
  error,
  busy = false,
  onInstall,
  onCancel,
}: {
  view: SetupView;
  error: string | null;
  busy?: boolean;
  onInstall: (when?: { time: string; days: number[] }) => void;
  onCancel: () => void;
}) {
  const openSettings = useStore((s) => s.openSettings);
  const daysId = useId();
  const [changing, setChanging] = useState(false);
  const [time, setTime] = useState(view.time ?? "");
  const [days, setDays] = useState<number[]>(view.days ?? WEEK);
  const ready = !busy && view.refused === null && (!changing || (time !== "" && days.length > 0));

  return (
    <div className="mx-auto max-w-[560px]">
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">{view.title}</h1>
      <p className="mt-1 text-[13px] text-muted">{view.body}</p>

      {changing ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-3">
          <label className="flex items-center gap-3 text-[12.5px] text-muted">
            <span className="w-14 shrink-0">{t("automations.page.time")}</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-fg outline-none focus-visible:border-line-strong"
            />
          </label>
          <div role="group" aria-labelledby={daysId} className="mt-3 flex items-center gap-3 text-[12.5px] text-muted">
            <span id={daysId} className="w-14 shrink-0">{t("automations.page.days")}</span>
            <div className="flex flex-wrap gap-1">
              {WEEK.map((day) => {
                const on = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDays(on ? days.filter((d) => d !== day) : [...days, day])}
                    className={`rounded-md border px-2 py-1 text-[12px] transition-colors ${on ? "border-ember bg-ember-soft text-fg" : "border-line text-faint hover:text-fg"}`}
                  >
                    {dayName(day)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-fg">
          <Clock size={13} className="text-muted" /> {view.when}
        </p>
      )}

      <h2 className="mt-6 text-[12px] font-medium text-muted">{t("automations.page.summary")}</h2>
      <Lines lines={view.lines} />

      {view.explanation && (
        <div className="mt-4">
          <h2 className="text-[12px] font-medium text-muted">{t("automations.page.explained")}</h2>
          <p className="selectable mt-1 text-[12.5px] leading-snug text-muted">{view.explanation}</p>
        </div>
      )}

      {view.off.length > 0 && (
        <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-warn">
          {view.off.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <button type="button" onClick={() => openSettings("connections")} className="mt-1.5 rounded-md border border-line px-2 py-0.5 text-[12px] text-fg hover:bg-surface-3">
            {t("automations.page.openConnections")}
          </button>
        </div>
      )}
      {view.refused && <p role="alert" className="mt-4 text-[12.5px] text-danger">{view.refused}</p>}
      {error && <p role="alert" className="mt-4 text-[12.5px] text-danger">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => onInstall(changing ? { time, days } : undefined)}
          className="rounded-lg bg-ember px-3.5 py-1.5 text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:bg-surface-3 disabled:text-faint"
        >
          {t("automations.page.install")}
        </button>
        {!changing && view.time !== null && view.refused === null && (
          <button type="button" onClick={() => setChanging(true)} className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg hover:bg-surface-2">
            {t("automations.page.change")}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
