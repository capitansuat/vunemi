/**
 * Automations: the scheduled tasks the user has, and the ones Vunemi offers
 * to set up. A recipe is set up from its summary; the lines of the summary
 * come from the main process, made from what the task's runs may use, so
 * this page shows them and decides nothing.
 */

import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Check, Clock, Workflow } from "lucide-react";
import { t } from "@vunemi/i18n";
import type { AutomationView, RecipeView } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { AutomationRow, useAutomations } from "./AutomationsSection.js";
import { SetupSummary, ShortcutSummary } from "./AutomationSetup.js";

const CATEGORIES = ["morning", "work", "files"] as const;

export function AutomationsView() {
  const library = useStore((s) => s.library);
  const refreshLibrary = useStore((s) => s.refreshLibrary);
  const { rows, error, act } = useAutomations();
  // The recipe whose summary is on screen; the empty chat screen can open the page on one.
  const [setup, setSetup] = useState<string | null>(() => useStore.getState().recipeFocus);
  const [deleted, setDeleted] = useState<AutomationView | null>(null);
  // The shortcut recipe whose summary is on screen.
  const [shortcut, setShortcut] = useState<string | null>(null);

  useEffect(() => {
    useStore.setState({ recipeFocus: null });
    // A connection may have been switched since the summaries were made.
    void refreshLibrary();
  }, [refreshLibrary]);

  const recipes = library?.recipes ?? [];
  const recipe = recipes.find((r) => r.id === setup);
  const has = (r: RecipeView) => rows?.some((row) => row.title === r.title) ?? false;
  const shortcuts = library?.shortcuts ?? [];
  const shortcutRecipe = shortcuts.find((r) => r.id === shortcut);

  if (shortcutRecipe) {
    return (
      <Page>
        <ShortcutSummary
          view={shortcutRecipe}
          onClose={() => {
            setShortcut(null);
            // It may be among the user's shortcuts now.
            void refreshLibrary();
          }}
        />
      </Page>
    );
  }

  if (recipe) {
    return (
      <Page>
        <SetupSummary
          view={recipe}
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
                      <span className="truncate">
                        {r.when} · {t("automations.badge.task")}
                      </span>
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
      {shortcuts.length > 0 && (
        <section aria-labelledby="recipes-shortcuts" className="mt-3">
          <h3 id="recipes-shortcuts" className="text-[11.5px] text-faint">{t("automations.category.shortcuts")}</h3>
          <ul className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {shortcuts.map((r) => (
              <li key={r.id} className="flex flex-col rounded-xl border border-line bg-surface p-3">
                <div className="text-[13.5px] font-medium text-fg">{r.title}</div>
                <p className="mt-0.5 flex-1 text-[12.5px] leading-snug text-muted">{r.body}</p>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-[11.5px] text-faint">
                    <Workflow size={11} className="shrink-0" />
                    <span className="truncate">{t("automations.badge.shortcut")}</span>
                  </span>
                  {r.installed ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-faint">
                      <Check size={12} /> {t("automations.page.installed")}
                    </span>
                  ) : (
                    <button type="button" onClick={() => setShortcut(r.id)} className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-fg hover:bg-surface-2">
                      {t("automations.page.install")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
