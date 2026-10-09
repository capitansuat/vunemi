/**
 * Automations: the scheduled tasks the user has, and the ones Vunemi offers
 * to set up. A recipe is set up from its summary; the lines of the summary
 * come from the main process, made from what the task's runs may use, so
 * this page shows them and decides nothing.
 */

import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Check, Clock, X } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { AutomationView, RecipeView } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { AutomationRow, useAutomations } from "./AutomationsSection.js";

const CATEGORIES = ["morning", "work", "files"] as const;
/** Monday first; 0 is Sunday, as the schedule counts them. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
// 3 Jan 2021 is a Sunday.
const dayName = (day: number) => formatDate(new Date(2021, 0, 3 + day), { weekday: "short" });

export function AutomationsView() {
  const library = useStore((s) => s.library);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const { rows, error, act } = useAutomations();
  // The recipe whose summary is on screen; the empty chat screen can open the page on one.
  const [setup, setSetup] = useState<string | null>(() => useStore.getState().recipeFocus);
  const [deleted, setDeleted] = useState<AutomationView | null>(null);

  useEffect(() => {
    useStore.setState({ recipeFocus: null });
    // A connection may have been switched since the summaries were made.
    void refreshLibrary();
  }, [refreshLibrary]);

  const recipes = library?.recipes ?? [];
  const recipe = recipes.find((r) => r.id === setup);
  const has = (r: RecipeView) => rows?.some((row) => row.title === r.title) ?? false;

  if (recipe) {
    return (
      <Page>
        <RecipeSetup
          recipe={recipe}
          error={error}
          onCancel={() => setSetup(null)}
          onInstall={(when) =>
            act(async () => {
              const next = await window.vunemi.installRecipe(recipe.id, when);
              setSetup(null);
              return next;
            })
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-fg">
        <CalendarClock size={17} className="text-muted" /> {t("automations.page.title")}
      </h1>
      <p className="mt-1 text-[13px] text-muted">{t("automations.page.intro")}</p>

      <h2 className="mt-7 text-[12px] font-medium text-muted">{t("automations.page.mine")}</h2>
      {rows !== null && rows.length === 0 && !deleted && <p className="mt-2 text-[13px] text-faint">{t("automations.page.mineEmpty")}</p>}
      <ul className="mt-2 space-y-2">
        {rows?.map((row) => <AutomationRow key={row.id} row={row} act={act} onDeleted={setDeleted} />)}
      </ul>
      {deleted && (
        <div role="status" className="mt-2 flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
          <span className="min-w-0 flex-1 truncate">{t("automations.page.deleted", { title: deleted.title })}</span>
          <button
            type="button"
            onClick={() => {
              setDeleted(null);
              act(() => window.vunemi.undoDeleteAutomation());
            }}
            className="shrink-0 rounded-md px-2 py-0.5 font-medium text-fg hover:bg-surface-3"
          >
            {t("common.undo")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}

      <h2 className="mt-8 text-[12px] font-medium text-muted">{t("automations.page.gallery")}</h2>
      {CATEGORIES.map((category) => {
        const inCategory = recipes.filter((r) => r.category === category);
        if (inCategory.length === 0) return null;
        return (
          <section key={category} aria-labelledby={`recipes-${category}`} className="mt-3">
            <h3 id={`recipes-${category}`} className="text-[11.5px] text-faint">{t(`automations.category.${category}`)}</h3>
            <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {inCategory.map((r) => (
                <li key={r.id} className="flex flex-col rounded-xl border border-line bg-surface p-3">
                  <div className="text-[13.5px] font-medium text-fg">{r.title}</div>
                  <p className="mt-0.5 flex-1 text-[12.5px] leading-snug text-muted">{r.body}</p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-[11.5px] text-faint">
                      <Clock size={11} className="shrink-0" />
                      <span className="truncate">{r.when}</span>
                    </span>
                    {has(r) ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-faint">
                        <Check size={12} /> {t("automations.page.installed")}
                      </span>
                    ) : (
                      <button type="button" onClick={() => setSetup(r.id)} className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-surface-2">
                        {t("automations.page.install")}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-8 pb-10">{children}</div>
    </div>
  );
}

/** What a recipe would do, before it is set up: nothing is scheduled until Set up is pressed. */
function RecipeSetup({
  recipe,
  error,
  onInstall,
  onCancel,
}: {
  recipe: RecipeView;
  error: string | null;
  onInstall: (when?: { time: string; days: number[] }) => void;
  onCancel: () => void;
}) {
  const openSettings = useStore((s) => s.openSettings);
  const [changing, setChanging] = useState(false);
  const [time, setTime] = useState(recipe.time ?? "");
  const [days, setDays] = useState<number[]>(recipe.days ?? WEEK);
  const ready = recipe.refused === null && (!changing || (time !== "" && days.length > 0));

  return (
    <div className="mx-auto max-w-[560px]">
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">{recipe.title}</h1>
      <p className="mt-1 text-[13px] text-muted">{recipe.body}</p>

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
          <div role="group" aria-labelledby="recipe-days" className="mt-3 flex items-center gap-3 text-[12.5px] text-muted">
            <span id="recipe-days" className="w-14 shrink-0">{t("automations.page.days")}</span>
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
          <Clock size={13} className="text-muted" /> {recipe.when}
        </p>
      )}

      <h2 className="mt-6 text-[12px] font-medium text-muted">{t("automations.page.summary")}</h2>
      <ul className="mt-2 space-y-1.5">
        {recipe.lines.map((line) => (
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

      {recipe.off.length > 0 && (
        <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-warn">
          {recipe.off.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <button type="button" onClick={() => openSettings("connections")} className="mt-1.5 rounded-md border border-line px-2 py-0.5 text-[12px] text-fg hover:bg-surface-3">
            {t("automations.page.openConnections")}
          </button>
        </div>
      )}
      {recipe.refused && <p role="alert" className="mt-4 text-[12.5px] text-danger">{recipe.refused}</p>}
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
        {!changing && recipe.time !== null && recipe.refused === null && (
          <button type="button" onClick={() => setChanging(true)} className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg hover:bg-surface-2">
            {t("automations.page.change")}
          </button>
        )}
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
