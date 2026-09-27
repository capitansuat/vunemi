import { useEffect, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { AutomationView } from "../../../shared/ipc.js";
import { Switch } from "./ConnectionsView.js";

/** What Vunemi offers to schedule; the main process adds the task itself (automations.ts SUGGESTIONS). */
const SUGGESTED = [
  { id: "morning-brief", key: "morning" },
  { id: "awaiting-reply", key: "awaiting" },
] as const;

const when = (at: number) => formatDate(at, { dateStyle: "medium", timeStyle: "short" });

/** Scheduled tasks: set up from chat with a card, looked after here. */
export function AutomationsSection() {
  const [rows, setRows] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.vunemi.listAutomations().then((list) => live && setRows(list));
    const off = window.vunemi.onAutomations(setRows);
    return () => {
      live = false;
      off();
    };
  }, []);

  const act = (fn: () => Promise<AutomationView[] | boolean>) => {
    setError(null);
    fn()
      .then((result) => {
        if (result === false) setError(t("automations.busy"));
        else if (Array.isArray(result)) setRows(result);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("automations.title")}</h2>
      <p className="mb-5 mt-1 text-[13px] text-muted">{t("automations.intro")}</p>
      {rows !== null && rows.length === 0 && <p className="text-[13px] text-faint">{t("automations.empty")}</p>}
      <ul className="space-y-2">
        {rows?.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-surface p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-fg">{row.title}</div>
                <div className="text-[12px] text-muted">{row.when}</div>
                <p className="mt-1 line-clamp-2 text-[12px] text-faint">{row.task}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-faint">
                  {row.next !== undefined && <span>{t("automations.next", { at: when(row.next) })}</span>}
                  {row.lastRunAt !== undefined && row.lastStatus && (
                    <span className={row.lastStatus === "done" ? "" : "text-danger"}>
                      {t("automations.last", { at: when(row.lastRunAt), status: t(`automations.status.${row.lastStatus}`) })}
                    </span>
                  )}
                </div>
              </div>
              <Switch on={row.enabled} label={row.title} disabled={false} onChange={(next) => act(() => window.vunemi.setAutomationEnabled(row.id, next))} />
            </div>
            <div className="mt-2 flex justify-end gap-1">
              <button type="button" onClick={() => act(() => window.vunemi.runAutomation(row.id))} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-fg">
                <Play size={12} /> {t("automations.runNow")}
              </button>
              <button type="button" onClick={() => act(() => window.vunemi.deleteAutomation(row.id))} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-danger">
                <Trash2 size={12} /> {t("common.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {rows !== null && SUGGESTED.some((s) => !rows.some((row) => row.title === t(`automations.suggest.${s.key}.title`))) && (
        <div className="mt-5 rounded-xl border border-dashed border-line p-3">
          <div className="text-[12px] font-medium text-faint">{t("automations.suggest.heading")}</div>
          {SUGGESTED.filter((s) => !rows.some((row) => row.title === t(`automations.suggest.${s.key}.title`))).map((s) => (
            <div key={s.id} className="mt-2 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-fg">{t(`automations.suggest.${s.key}.title`)}</div>
                <p className="mt-0.5 text-[12px] text-muted">{t(`automations.suggest.${s.key}.body`)}</p>
              </div>
              <button type="button" onClick={() => act(() => window.vunemi.addSuggestedAutomation(s.id))}
                className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-surface-2">
                {t("automations.suggest.add")}
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
