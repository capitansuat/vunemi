import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Globe, Hand, Play, Plus, RotateCw, ShieldAlert, X } from "lucide-react";
import { callDetail, toolLabel } from "../lib/labels.js";
import type { EmbeddedTab } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

/**
 * The browser inside the Vunemi window. The page itself is a native view the
 * main process lays over the `stage` element; this component draws the
 * chrome around it and reports where the stage is.
 */
export function BrowserPane() {
  const { embedded, setPaneOpen } = useStore();
  const active = embedded.tabs.find((t) => t.id === embedded.activeId) ?? null;
  const stage = useRef<HTMLDivElement>(null);

  // Keep the native page glued to the stage.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !active) {
      window.vunemi.embeddedBounds(null);
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      window.vunemi.embeddedBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [active?.id]);

  useEffect(() => () => window.vunemi.embeddedBounds(null), []);

  return (
    <aside className="flex w-[46%] min-w-[420px] max-w-[820px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="drag flex h-[52px] shrink-0 items-end gap-1 px-2 pt-2">
        <div className="scroll-thin flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {embedded.tabs.map((t) => (
            <TabChip key={t.id} tab={t} active={t.id === embedded.activeId} />
          ))}
          <button
            type="button"
            aria-label={t("pane.newTab")}
            title={t("pane.newTab")}
            onClick={() =>
              void window.vunemi.embeddedOpen("about:blank").then(() => document.getElementById("vunemi-address")?.focus())
            }
            className="no-drag mb-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Plus size={14} />
          </button>
        </div>
        <AutoOpenToggle />
        <button
          type="button"
          aria-label={t("pane.closeLabel")}
          title={t("pane.close")}
          onClick={() => setPaneOpen(false)}
          className="no-drag mb-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <Toolbar tab={active} />
      <AgentBar />
      {active?.blocked && <BlockedBar blocked={active.blocked} />}

      <div ref={stage} className="relative min-h-0 flex-1 bg-bg">
        {!active && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div>
              <div className="mx-auto grid size-10 place-items-center rounded-xl bg-surface-2">
                <Globe size={18} className="text-muted" />
              </div>
              <p className="mt-3 text-[13px] text-muted">{t("pane.emptyTitle")}</p>
              <p className="mt-1 text-[12px] text-faint">
                {t("pane.emptyBody")}
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Why the page is Chromium's error page: it is on a private network. Above
 * the page, since the page is a native view the HTML can't cover.
 */
function BlockedBar({ blocked }: { blocked: NonNullable<EmbeddedTab["blocked"]> }) {
  const openSettings = useStore((s) => s.openSettings);
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-line bg-surface-2 px-3 py-2 text-[12px] text-fg" role="status">
      <ShieldAlert size={14} className="mt-px shrink-0 text-muted" />
      <span className="min-w-0 flex-1">{t(blocked.trustable ? "pane.blocked" : "pane.blockedOwn", { host: blocked.host })}</span>
      {blocked.trustable && (
        <button
          type="button"
          onClick={() => openSettings("security")}
          className="shrink-0 rounded-md border border-line-strong bg-surface px-2.5 py-0.5 text-[12px] font-medium hover:bg-bg"
        >
          {t("pane.openSettings")}
        </button>
      )}
    </div>
  );
}

/** Who has the page right now, and what the agent is doing on it. */
function AutoOpenToggle() {
  const { browserAutoOpen, setBrowserAutoOpen } = useStore();
  return (
    <label className="no-drag mb-1.5 flex shrink-0 items-center gap-1.5 px-1 text-[11.5px] text-muted" title={t("pane.autoOpenHint")}>
      <input type="checkbox" checked={browserAutoOpen} onChange={(e) => setBrowserAutoOpen(e.target.checked)} className="accent-ember" />
      {t("pane.autoOpen")}
    </label>
  );
}

/**
 * Above the composer while the agent uses the browser with the panel closed:
 * what it is looking at, and a way to watch.
 */
export function BackgroundBrowsing() {
  const { embedded, paneOpen, running, setPaneOpen } = useStore();
  const tab = embedded.tabs.find((t) => t.agent && t.id === embedded.activeId) ?? embedded.tabs.find((t) => t.agent);
  if (paneOpen || !running || !tab) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-4 text-[12.5px] text-muted" role="status">
      <Globe size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("pane.background", { title: tab.title })}</span>
      <button type="button" onClick={() => setPaneOpen(true)} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-fg hover:bg-surface-2">
        {t("pane.watch")}
      </button>
    </div>
  );
}

function AgentBar() {
  const { running, paused, pause, resume } = useStore();
  const current = useStore((s) => {
    const run = s.runs.at(-1);
    if (!run || run.status !== "running") return null;
    const calls = run.steps.flatMap((st) => st.calls);
    const c = calls.findLast((c) => c.status === "running" || c.status === "proposed" || c.status === "awaiting");
    if (!c) return t("pane.thinking");
    const d = callDetail(c);
    return `${toolLabel(c.tool, c.status)}${d ? ` · ${d}` : ""}`;
  });
  if (!running) return null;

  return (
    <div
      className={`flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[12px] ${
        paused ? "border-ok/30 bg-ok/10 text-fg" : "border-ember/30 bg-ember-soft text-fg"
      }`}
      role="status"
    >
      {paused ? (
        <>
          <Hand size={13} className="shrink-0 text-ok" />
          <span className="min-w-0 flex-1 truncate">
            <b className="font-medium">{t("pane.youHaveControl")}</b> <span className="text-muted">{t("pane.agentWaiting")}</span>
          </span>
          <button
            type="button"
            onClick={() => void resume()}
            className="flex shrink-0 items-center gap-1 rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
          >
            <Play size={11} fill="currentColor" /> {t("composer.resume")}
          </button>
        </>
      ) : (
        <>
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inset-0 animate-ping rounded-full bg-ember opacity-60 motion-reduce:animate-none" />
            <span className="relative size-2 rounded-full bg-ember" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            <b className="font-medium">{t("pane.agentWorking")}</b> <span className="text-muted">· {current}</span>
          </span>
          <button
            type="button"
            onClick={() => void pause()}
            title={t("pane.takeControlHint")}
            className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12px] font-medium hover:bg-surface-2"
          >
            <Hand size={12} /> {t("pane.takeControl")}
          </button>
        </>
      )}
    </div>
  );
}

function TabChip({ tab, active }: { tab: EmbeddedTab; active: boolean }) {
  return (
    <div
      className={`no-drag group flex h-8 w-[168px] min-w-[96px] shrink items-center gap-1.5 rounded-t-lg pl-2.5 pr-1 text-[12px] ${
        active ? "bg-bg text-fg" : "text-muted hover:bg-surface-2"
      }`}
    >
      <button
        type="button"
        onClick={() => void window.vunemi.embeddedActivate(tab.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={tab.title}
      >
        {tab.loading ? (
          <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ember" />
        ) : tab.agent ? (
          <Bot size={12} className="shrink-0 text-ember" />
        ) : (
          <Globe size={12} className="shrink-0 text-faint" />
        )}
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        aria-label={t("pane.closeTab", { title: tab.title })}
        onClick={() => void window.vunemi.embeddedClose(tab.id)}
        className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 hover:bg-surface-3 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function Toolbar({ tab }: { tab: EmbeddedTab | null }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(tab?.url && tab.url !== "about:blank" ? tab.url : "");
  }, [tab?.url, tab?.id, editing]);

  const go = async () => {
    const url = draft.trim();
    if (!url) return;
    try {
      if (tab) await window.vunemi.embeddedNavigate(tab.id, url);
      else await window.vunemi.embeddedOpen(url);
      setError(null);
      setEditing(false);
      (document.activeElement as HTMLElement | null)?.blur();
    } catch {
      setError(t("pane.webOnly"));
    }
  };

  const nav = (action: "back" | "forward" | "reload" | "stop") => tab && void window.vunemi.embeddedHistory(tab.id, action);
  const iconBtn = "grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-bg px-2">
      <button type="button" aria-label={t("pane.back")} disabled={!tab?.canGoBack} onClick={() => nav("back")} className={iconBtn}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" aria-label={t("pane.forward")} disabled={!tab?.canGoForward} onClick={() => nav("forward")} className={iconBtn}>
        <ArrowRight size={15} />
      </button>
      <button
        type="button"
        aria-label={tab?.loading ? t("composer.stop") : t("pane.reload")}
        disabled={!tab}
        onClick={() => nav(tab?.loading ? "stop" : "reload")}
        className={iconBtn}
      >
        {tab?.loading ? <X size={15} /> : <RotateCw size={14} />}
      </button>

      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input
          id="vunemi-address"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          placeholder={t("pane.addressPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("pane.address")}
          aria-invalid={error !== null}
          title={error ?? undefined}
          className={`h-7 w-full rounded-md border bg-surface px-2.5 text-[12.5px] text-fg placeholder:text-faint focus:border-ember focus:outline-none ${
            error ? "border-danger" : "border-line"
          }`}
        />
      </form>

      {tab?.agent && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full bg-ember-soft px-2 py-0.5 text-[11px] font-medium text-ember"
          title={t("pane.agentTabHint")}
        >
          <Bot size={11} /> {t("pane.agent")}
        </span>
      )}
    </div>
  );
}
