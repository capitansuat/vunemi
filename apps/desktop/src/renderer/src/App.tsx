import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Bug, TriangleAlert, Lock, MessageSquare, Minimize2, Package, PanelLeftClose, PanelLeftOpen, PanelRight, Settings2, SquarePen, Trash2, Users } from "lucide-react";
import { ArtefactsView } from "./components/ArtefactsView.js";
import { MeetingsView } from "./components/MeetingsView.js";
import { ProjectNotesView } from "./components/WorkNotes.js";
import { BackgroundBrowsing, BrowserPane } from "./components/BrowserPane.js";
import { PicturePane } from "./components/PicturePane.js";
import { SitePane } from "./components/SitePane.js";
import { Composer } from "./components/Composer.js";
import { EngineBanner, EngineSetup } from "./components/EngineSetup.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { Mochi } from "./components/Mochi.js";
import { SessionsNav } from "./components/SessionsNav.js";
import { SettingsView } from "./components/SettingsView.js";
import { Turn } from "./components/Turn.js";
import { openReplies, runStats } from "./lib/fold.js";
import type { LedgerKind } from "@vunemi/agent-core";
import { available, GOALS, IDEAS, PROJECT_GOALS, PROJECT_IDEAS, switchable } from "./lib/suggestions.js";
import { ICONS } from "./components/ConnectionsView.js";
import { formatTokens } from "./lib/labels.js";
import { clock, dayLabel } from "./lib/time.js";
import { useStore, type View } from "./store.js";
import { t } from "@vunemi/i18n";
import type { UpdateStatus } from "../../shared/ipc.js";
import { UpdateAction } from "./components/UpdateAction.js";


export function App() {
  const { runs, pendingStart, ingest, refreshProviders, setEmbedded, setQueue, setSessions, setEngine, refreshEngine } = useStore();
  const showPane = useStore((s) => s.paneOpen);
  const viewer = useStore((s) => s.viewer);
  const preview = useStore((s) => s.preview);
  const view = useStore((s) => s.view);

  useEffect(() => {
    // Once the model is known, a meeting Vunemi quit during can be finished and summarised.
    void refreshProviders().finally(() => void window.vunemi.meetingsRecover(useStore.getState().model));
    // Subscribed here, not in the pane, so a tab the agent opens can bring
    // the closed pane up.
    void window.vunemi.getEmbedded().then(setEmbedded);
    const offEmbedded = window.vunemi.onEmbeddedState(setEmbedded);
    const offEvents = window.vunemi.onEvent(ingest);
    // The queue lives in main, so a window reload finds it still there.
    void window.vunemi.listQueued().then(setQueue);
    const offQueue = window.vunemi.onQueue(setQueue);
    void window.vunemi.listSessions().then((list) => {
      setSessions(list);
      // After a crash, come back to the task it cut short, unless a conversation is already open.
      const cut = list.sessions.find((s) => s.interrupted);
      const fresh = !list.sessions.some((s) => s.id === list.current);
      if (cut && fresh) void useStore.getState().openSession(cut.id).catch(() => {});
    });
    const offSessions = window.vunemi.onSessions(setSessions);
    void refreshEngine();
    const offEngine = window.vunemi.onEngine(setEngine);
    return () => {
      offEngine();
      offEmbedded();
      offEvents();
      offQueue();
      offSessions();
    };
  }, [ingest, refreshProviders, setEmbedded, setQueue, setSessions, setEngine, refreshEngine]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <DebugPortWarning />
        {view === "chat" ? <TopBar /> : <PageBar />}
        {view === "artefacts" ? (
          <ArtefactsView />
        ) : view === "meetings" ? (
          <MeetingsView />
        ) : view === "notes" ? (
          <ProjectNotesView />
        ) : view === "settings" ? (
          <SettingsView />
        ) : (
          <>
            {runs.length === 0 && !pendingStart ? <Empty /> : <Conversation />}
            <div className="mx-auto w-full max-w-[760px] px-6 pb-5">
              <EngineBanner />
              <BackgroundBrowsing />
              <Composer />
            </div>
          </>
        )}
      </main>
      {/* The browser belongs to the conversation; Settings and what Vunemi made get the whole window. */}
      {/* A picture opened from a card sits where the browser would; closing it brings the browser back. */}
      {view === "chat" && (viewer ? <PicturePane /> : preview ? <SitePane /> : showPane && <BrowserPane />)}
    </div>
  );
}

/** Always on screen while remote debugging is open: another program could be answering the cards. */
function DebugPortWarning() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void window.vunemi.debugPortOpen().then(setOpen, () => setOpen(false));
  }, []);
  if (!open) return null;
  return (
    <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">
      {t("app.debugPort.warning")}
    </div>
  );
}

/**
 * Kept short on purpose: the conversation, what it made, and the projects
 * it happened in. Everything else — connections, the vault, the outbox, the
 * activity log — lives in Settings. Folds down to a strip of icons.
 */
function Sidebar() {
  const { newSession, running, navFolded, setNavFolded } = useStore();
  if (navFolded) {
    return (
      <aside className="drag flex w-[60px] shrink-0 flex-col items-center border-r border-line bg-surface">
        {/* Space for the macOS traffic lights. */}
        <div className="h-[52px]" />
        <div className="no-drag flex flex-col items-center gap-1">
          <IconButton label={t("app.nav.unfold")} icon={PanelLeftOpen} onClick={() => setNavFolded(false)} />
          <IconButton label={t("app.newSession")} icon={SquarePen} onClick={() => void newSession()} disabled={running} />
          <ViewButton view="chat" label={t("app.nav.chat")} icon={MessageSquare} folded />
          <ViewButton view="artefacts" label={t("app.nav.artefacts")} icon={Package} folded />
          <ViewButton view="meetings" label={t("app.nav.meetings")} icon={Users} folded />
        </div>
        <div className="no-drag mt-auto flex flex-col items-center gap-1 pb-4">
          <IconButton label={t("app.reportProblem")} icon={Bug} onClick={() => void window.vunemi.reportProblem()} />
          <ViewButton view="settings" label={t("app.nav.settings")} icon={Settings2} folded />
        </div>
      </aside>
    );
  }
  return (
    <aside className="drag flex w-[232px] shrink-0 flex-col border-r border-line bg-surface">
      {/* Space for the macOS traffic lights. */}
      <div className="h-[52px]" />
      <div className="flex items-center gap-2 pb-4 pl-4 pr-2">
        <div className="grid size-7 place-items-center rounded-lg bg-ember-soft">
          <Mochi size={18} className="text-ember" />
        </div>
        <span className="flex-1 text-[15px] font-semibold tracking-tight text-fg">Vunemi</span>
        <div className="no-drag">
          <IconButton label={t("app.nav.fold")} icon={PanelLeftClose} onClick={() => setNavFolded(true)} />
        </div>
      </div>

      <div className="no-drag px-2.5">
        <button
          type="button"
          onClick={() => void newSession()}
          disabled={running}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          <SquarePen size={14} className="text-muted" />
          {t("app.newSession")}
        </button>
      </div>

      <div className="no-drag mt-3 px-2.5">
        <ViewButton view="chat" label={t("app.nav.chat")} icon={MessageSquare} />
        <ViewButton view="artefacts" label={t("app.nav.artefacts")} icon={Package} />
        <ViewButton view="meetings" label={t("app.nav.meetings")} icon={Users} />
      </div>

      <SessionsNav />

      <div className="no-drag flex items-center gap-1 border-t border-line px-2.5 pt-2">
        <div className="min-w-0 flex-1">
          <ViewButton view="settings" label={t("app.nav.settings")} icon={Settings2} />
        </div>
        <IconButton label={t("app.reportProblem")} icon={Bug} onClick={() => void window.vunemi.reportProblem()} />
      </div>
      <AppVersion />
    </aside>
  );
}

/** Which Vunemi this is, so nobody has to guess after an update, and whether a newer one is out. */
function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void window.vunemi.appVersion().then(setVersion, () => setVersion(null));
    void window.vunemi.updatesStatus().then(setUpdate, () => setUpdate(null));
    return window.vunemi.onUpdates(setUpdate);
  }, []);
  const offer = update && ["available", "downloading", "ready", "failed"].includes(update.phase) ? update.offer : null;
  return (
    <div className="px-4 pb-4 pt-1.5 pl-[42px] text-[11px] text-faint">
      {offer && update && (
        <details className="no-drag mb-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-fg">
          <summary className="cursor-pointer font-medium">{t("updates.available", { version: offer.version })}</summary>
          {offer.notes.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
              {offer.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
          <UpdateAction status={update} />
        </details>
      )}
      <div className="selectable tabular-nums">{version ? `Vunemi ${version}` : "\u00a0"}</div>
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: typeof Package; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
    >
      <Icon size={15} />
    </button>
  );
}

function ViewButton({
  view,
  label,
  icon: Icon,
  folded = false,
}: {
  view: View;
  label: string;
  icon: typeof Package;
  folded?: boolean;
}) {
  const { view: current, setView } = useStore();
  const on = current === view;
  if (folded) {
    return (
      <button
        type="button"
        onClick={() => setView(view)}
        aria-current={on ? "page" : undefined}
        aria-label={label}
        title={label}
        className={`grid size-8 place-items-center rounded-lg transition-colors ${on ? "bg-surface-2 text-ember" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
      >
        <Icon size={15} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setView(view)}
      aria-current={on ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
        on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      <Icon size={14} className={on ? "text-ember" : "text-muted"} />
      {label}
    </button>
  );
}

function TopBar() {
  const runs = useStore((s) => s.runs);
  const context = useStore((s) => s.context);
  const last = runs.at(-1);
  const compacted = last?.compaction?.status === "done" ? last.compaction.after : null;
  const used = compacted ?? (last ? runStats(last).lastPromptTokens : null) ?? context?.estimate ?? null;
  // After a compaction the last request no longer describes what's sent next.
  const parts = compacted === null && last ? runStats(last).lastParts : null;

  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
      <ModelPicker />
      {/* The promise that matters most, one hover away instead of a paragraph in the sidebar. */}
      <span role="img" tabIndex={0} aria-label={t("app.local")} title={t("app.local")} className="no-drag grid size-7 place-items-center rounded-md text-faint hover:text-muted focus-visible:text-muted">
        <Lock size={13} />
      </span>
      <div className="flex-1" />
      {used !== null && <ContextMeter used={used} budget={context?.window ?? 32_768} known={context?.known ?? false} parts={parts} />}
      <PaneToggle />
    </header>
  );
}

/** Above Settings and what Vunemi made: the way back, in words, and Esc does the same. */
function PageBar() {
  const setView = useStore((s) => s.setView);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A field or an open dialog keeps its own Escape.
      if (document.querySelector("[role=dialog]") || (e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))) return;
      setView("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);
  return (
    <header className="drag flex h-[52px] shrink-0 items-center border-b border-line px-4">
      <button
        type="button"
        onClick={() => setView("chat")}
        className="no-drag inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <ArrowLeft size={14} />
        {t("app.nav.back")}
      </button>
    </header>
  );
}

function PaneToggle() {
  const { paneOpen, setPaneOpen } = useStore();
  return (
    <button
      type="button"
      aria-label={paneOpen ? t("app.pane.hide") : t("app.pane.show")}
      aria-pressed={paneOpen}
      title={paneOpen ? t("app.pane.hide") : t("app.pane.show")}
      onClick={() => setPaneOpen(!paneOpen)}
      className={`no-drag grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2 ${
        paneOpen ? "text-fg" : "text-muted"
      }`}
    >
      <PanelRight size={15} />
    </button>
  );
}

const PART_ORDER: readonly LedgerKind[] = ["system", "instructions", "tools", "conversation", "toolOutputs", "images"];

/** The last request part by part, largest first: where the context goes. */
function partLines(parts: Partial<Record<LedgerKind, number>> | null): string[] {
  if (!parts) return [];
  const lines = PART_ORDER.flatMap((kind) => (parts[kind] ? [[kind, parts[kind]!] as const] : []))
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `  ${t(`context.parts.${kind}`)}: ${formatTokens(n)}`);
  return lines.length ? ["", `${t("context.lastRequest")}:`, ...lines] : [];
}

function ContextMeter({ used, budget, known, parts }: { used: number; budget: number; known: boolean; parts: Partial<Record<LedgerKind, number>> | null }) {
  const running = useStore((s) => s.running);
  const hasRuns = useStore((s) => s.runs.length > 0);
  const compactNow = useStore((s) => s.compactNow);
  const [busy, setBusy] = useState(false);
  const ratio = Math.min(used / budget, 1);
  const tone = ratio > 0.8 ? "bg-danger" : ratio > 0.5 ? "bg-warn" : "bg-ok";
  const title = [t("app.context", { used, budget }), known ? null : t("context.estimated", { budget }), ...partLines(parts)].filter((line) => line !== null).join("\n");
  return (
    <div className="no-drag flex shrink-0 items-center gap-2 text-[11.5px] text-faint" title={title}>
      <span className="whitespace-nowrap tabular-nums">
        {formatTokens(used)} / {formatTokens(budget)}
      </span>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${Math.max(ratio * 100, 2)}%` }} />
      </div>
      <button
        type="button"
        disabled={running || busy || !hasRuns}
        onClick={() => {
          setBusy(true);
          void compactNow().finally(() => setBusy(false));
        }}
        aria-label={t("context.compactNow")}
        title={`${t("context.compactNow")} — ${t("context.compactHint")}`}
        className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
      >
        <Minimize2 size={13} />
      </button>
    </div>
  );
}

function Conversation() {
  const runs = useStore((s) => s.runs);
  const replies = openReplies(runs);
  const pendingStart = useStore((s) => s.pendingStart);
  const stop = useStore((s) => s.stop);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-[760px] space-y-9 px-6 pt-8 pb-10">
        {runs.map((r) => (
          <Turn key={r.runId} run={r} {...(replies?.runId === r.runId && { replies: replies.options })} />
        ))}
        {pendingStart && <section className="space-y-4">
          <div className="flex justify-end">
            <div className="selectable max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-surface-3 px-4 py-3 text-[13px] text-fg">{pendingStart.goal}</div>
          </div>
          <div role="status" className="flex items-center gap-2 text-[12px] text-muted">
            <span className="size-2 animate-pulse rounded-full bg-ember" />{t("callStatus.proposed")}
            <button type="button" onClick={() => void stop()} className="ml-2 text-faint underline hover:text-fg">{t("composer.stop")}</button>
          </div>
        </section>}
        <Interrupted />
      </div>
    </div>
  );
}

/** The last task here was cut short by Vunemi closing; picking it up is the user's call. */
function Interrupted() {
  const { sessions, running, model, setSessions } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cut = sessions.sessions.find((s) => s.id === sessions.current)?.interrupted;
  useEffect(() => setBusy(false), [sessions.current]);
  if (!cut || running) return null;

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().catch((e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    });
  };
  return (
    <div role="status" className="rounded-xl border border-warn-line bg-warn-soft p-3.5">
      <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
        <TriangleAlert size={14} className="text-warn" />
        {t("app.recovery.title")}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-snug text-muted">
        {t("app.recovery.steps", { count: cut.steps })} {t("app.recovery.body")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !model}
          onClick={() => act(() => window.vunemi.resumeInterrupted(model!))}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t("app.recovery.resume")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act(async () => { setSessions(await window.vunemi.dismissInterrupted()); setBusy(false); })}
          className="rounded-lg px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          {t("app.recovery.dismiss")}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

function Empty() {
  const { send, suggest, model, providers, engine, sessions, openConnection } = useStore();
  const project = sessions.projects.find((p) => p.id === sessions.project) ?? null;
  // Which connections are switched on; suggestions that need one wait for it.
  const [ready, setReady] = useState<Set<string> | null>(null);
  // An idea starts a task at once: one click, one task.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let live = true;
    void window.vunemi.connectionsOn().then(
      (ids) => { if (live) setReady(new Set(ids)); },
      () => { if (live) setReady(new Set()); },
    );
    return () => { live = false; };
  }, []);
  const goals = available(project ? PROJECT_GOALS : GOALS, ready);
  const ideas = available(project ? PROJECT_IDEAS : IDEAS, ready);
  const discover = project ? [] : switchable(ready);
  // No model anywhere: getting one is the only useful thing on this screen.
  const setup = providers !== null && providers.every((p) => p.models.length === 0) && engine?.available === true;
  return (
    // Auto margins centre it when it fits and let it scroll when the model list does not.
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8 scroll-thin">
      <div className="mt-auto grid size-12 shrink-0 place-items-center rounded-2xl bg-ember-soft">
        <Mochi size={30} className="text-ember" />
      </div>
      <h1 className="mt-4 text-[22px] font-semibold tracking-tight text-fg">
        {setup ? t("engine.setup.title") : project ? project.name : t("app.empty.title")}
      </h1>
      <p className="mt-1.5 max-w-sm text-center text-[13.5px] text-muted">
        {setup ? t("engine.setup.body") : project ? t("app.projects.emptyBody", { folder: project.folder }) : t("app.empty.body")}
      </p>
      {!setup && project?.missing && (
        <p className="mt-2 max-w-sm text-center text-[12.5px] text-warn">{t("app.projects.missingBody")}</p>
      )}
      {setup ? (
        <div className="mb-auto mt-6 flex w-full justify-center">
          <EngineSetup intro={false} />
        </div>
      ) : (
      <div className="mb-auto mt-6 flex w-full max-w-lg flex-col gap-5">
        {goals.length > 0 && (
          <section aria-labelledby="empty-goals">
            <h2 id="empty-goals" className="text-center text-[12px] font-medium text-muted">{t("app.goalsTitle")}</h2>
            <p className="mt-0.5 text-center text-[11.5px] text-faint">{t("app.goalsHint")}</p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {goals.map(({ key }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => suggest(t(key))}
                  className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </section>
        )}
        <section aria-labelledby="empty-ideas">
          <h2 id="empty-ideas" className="text-center text-[12px] font-medium text-muted">{t("app.ideasTitle")}</h2>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {ideas.map(({ key }) => (
              <button
                key={key}
                type="button"
                disabled={!model || sent}
                onClick={() => {
                  setSent(true);
                  void send(t(key)).catch(() => setSent(false));
                }}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50"
              >
                {t(key)}
              </button>
            ))}
          </div>
        </section>
        {discover.length > 0 && (
          <section aria-labelledby="empty-discover">
            <h2 id="empty-discover" className="text-center text-[12px] font-medium text-muted">{t("app.discover.title")}</h2>
            <p className="mt-0.5 text-center text-[11.5px] text-faint">{t("app.discover.hint")}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {discover.map(({ id, key }) => {
                const Icon = ICONS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => openConnection(id)}
                    className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[12.5px] leading-snug text-muted transition-colors hover:border-line-strong hover:text-fg"
                  >
                    {Icon && <Icon size={15} className="mt-px shrink-0 text-ember" />}
                    <span>{t(key)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
      )}
    </div>
  );
}
