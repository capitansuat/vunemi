import { useEffect, useState, type ReactNode } from "react";
import { Check, Download, Eye, Heart, Loader2, Search, ShieldCheck, Trash2, X } from "lucide-react";
import type { InspectView, PopularView, SearchHitView } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { contextChoices, contextMemory, etaMinutes, formatGB, tooLarge } from "../lib/format.js";
import { getLocale, t } from "@vunemi/i18n";

/**
 * How someone with no model gets one: every suggested model that fits this
 * Mac, the best first, or anything else from Hugging Face. Nothing is downloaded
 * until the button is pressed.
 */
/** `intro={false}` where the screen around it already says what a model is for. */
export function EngineSetup({ showInstalled = false, intro = true }: { showInstalled?: boolean; intro?: boolean }) {
  const engine = useStore((s) => s.engine);
  const refreshProviders = useStore((s) => s.refreshProviders);
  const setModel = useStore((s) => s.setModel);
  const setView = useStore((s) => s.setView);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<InspectView | null>(null);
  const [popular, setPopular] = useState<PopularView[] | null>(null);
  // Four choices at first; the rest on request.
  const [expanded, setExpanded] = useState(false);
  const locale = getLocale();
  const available = engine?.available === true;

  // Only while the card is on screen, and main asks Hugging Face at most once a day.
  useEffect(() => {
    if (!available) return;
    let live = true;
    window.vunemi.enginePopular().then(
      (items) => live && setPopular(items),
      () => live && setPopular([]),
    );
    return () => {
      live = false;
    };
  }, [available]);

  if (!engine) return null;
  if (!engine.available) {
    return <p className="max-w-md text-center text-[13px] text-muted">{t("engine.setup.unavailable")}</p>;
  }

  async function start(req: Parameters<typeof window.vunemi.engineDownload>[0]) {
    setError(null);
    try {
      const spec = await window.vunemi.engineDownload(req);
      if (!spec) return;
      await refreshProviders();
      setModel(spec);
      setPicked(null);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    }
  }

  async function addLocal() {
    setError(null);
    try {
      const spec = await window.vunemi.engineAddLocal();
      if (!spec) return;
      await refreshProviders();
      setModel(spec);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    }
  }

  const dl = engine.download;
  const [recommended, ...smaller] = engine.choices;
  const has = (id: string) => engine.installed.some((m) => m.id === id);
  // Something is hidden behind "More options": popular beyond the first three, or the smaller list.
  const canExpand = popular !== null && (popular.length > 0 ? popular.length > 3 || smaller.length > 0 : smaller.length > 3);

  return (
    <div className="w-full max-w-md space-y-3">
      {showInstalled && engine.installed.length > 0 && <Installed />}

      {dl ? (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[13.5px] font-medium text-fg">{dl.vision ? t("engine.download.vision", { name: dl.name }) : dl.name}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-ember transition-[width]" style={{ width: `${Math.min(100, (dl.received / dl.total) * 100)}%` }} />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[12px] text-muted">
            <span>{t("engine.download.progress", { received: formatGB(dl.received, locale), total: formatGB(dl.total, locale) })}</span>
            <span>{dl.state === "testing" ? t("engine.download.testing") : dl.state === "paused" ? t("engine.download.paused") : eta(dl.total - dl.received, dl.bytesPerSecond)}</span>
          </div>
          <div className="mt-3 flex justify-end">
            {dl.state === "downloading" && (
              <button type="button" onClick={() => void window.vunemi.engineCancel()} className="rounded-lg px-2.5 py-1 text-[12.5px] text-muted hover:bg-surface-2">
                {t("engine.download.cancel")}
              </button>
            )}
            {dl.state === "paused" && (
              <button type="button" onClick={() => void start({ resume: true })} className="rounded-lg bg-ember px-3 py-1.5 text-[12.5px] font-medium text-white">
                {t("engine.download.resume")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-4">
          {intro && <div className="mb-3 text-[13px] text-muted">{t("engine.setup.body")}</div>}
          <div className="space-y-2">
          {picked?.ok && (
            <Offer name={picked.name} detail={`${picked.repo} · ${formatGB(picked.size, locale)} · ${t("engine.setup.license", { license: picked.license })}`}
              onDownload={() => void start({ repo: picked.repo })} onClose={() => setPicked(null)} primary />
          )}
          {recommended && (
            <Offer name={recommended.name} badge={t("engine.setup.badge")}
              detail={`${formatGB(recommended.size, locale)} · ${t("engine.setup.license", { license: recommended.license })}`}
              onDownload={() => void start({ catalog: recommended.id })} primary={!picked?.ok}
              have={has(recommended.id)} />
          )}
          </div>

          {popular === null ? (
            <p className="mt-4 flex items-center gap-1.5 text-[12px] text-faint"><Loader2 size={12} className="animate-spin" /> {t("engine.popular.loading")}</p>
          ) : popular.length > 0 && (
            <>
              <div className="mt-4 text-[11.5px] font-medium uppercase tracking-wide text-faint">{ownLetters(t("engine.popular.title"), "Hugging Face")}</div>
              <div className="mt-2 space-y-2">
                {(expanded ? popular : popular.slice(0, 3)).map((p) => (
                  <Offer key={p.repo} name={p.name}
                    detail={<>{p.maker} · <Heart size={10} className="inline -mt-px" /> {new Intl.NumberFormat(locale).format(p.likes)} · {formatGB(p.size, locale)} · {t("engine.setup.license", { license: p.license })}</>}
                    onDownload={() => void start({ repo: p.repo })} have={has(p.id)} />
                ))}
              </div>
            </>
          )}

          {smaller.length > 0 && (popular?.length === 0 || expanded) && (
            <>
              <div className="mt-4 text-[11.5px] font-medium uppercase tracking-wide text-faint">{t("engine.setup.more")}</div>
              <div className="mt-2 space-y-2">
                {(expanded ? smaller : smaller.slice(0, 3)).map((c) => (
                  <Offer key={c.id} name={c.name}
                    detail={`${formatGB(c.size, locale)} · ${t("engine.setup.license", { license: c.license })}`}
                    onDownload={() => void start({ catalog: c.id })} have={has(c.id)} />
                ))}
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {canExpand && (
              <button type="button" onClick={() => setExpanded(!expanded)} className="text-muted underline-offset-2 hover:underline">
                {expanded ? `${t("engine.setup.fewer")} ▴` : `${t("engine.setup.moreOptions")} ▾`}
              </button>
            )}
            {!showInstalled && (
              <button type="button" onClick={() => setView("settings")} className="text-muted underline-offset-2 hover:underline">
                {t("engine.setup.otherServer")}
              </button>
            )}
            <button type="button" onClick={() => void addLocal()} title={t("engine.local.note")} className="text-muted underline-offset-2 hover:underline">
              {t("engine.local.add")}
            </button>
          </div>
          <ModelSearch onPick={setPicked} />
        </div>
      )}
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
    </div>
  );

  function eta(remaining: number, speed: number): string {
    const minutes = etaMinutes(remaining, speed);
    if (minutes === null) return "";
    return minutes <= 1 ? t("engine.download.etaSoon") : t("engine.download.eta", { minutes });
  }
}

/**
 * A heading shown in capitals takes them by the app language's rules, and
 * Turkish would write "HUGGİNG FACE". A name from elsewhere keeps its own letters.
 */
function ownLetters(text: string, name: string): ReactNode {
  const at = text.indexOf(name);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<span lang="en">{name}</span>{text.slice(at + name.length)}</>;
}

function Offer({ name, detail, badge, primary = false, have = false, onDownload, onClose }: {
  name: string;
  detail: ReactNode;
  badge?: string | undefined;
  primary?: boolean;
  /** Already downloaded: nothing to press. */
  have?: boolean;
  onDownload: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-fg">{name}</span>
          {badge && <span className="shrink-0 rounded-md bg-ember-soft px-1.5 py-px text-[10.5px] font-medium text-ember">{badge}</span>}
        </div>
        <div className="truncate text-[11.5px] text-faint">{detail}</div>
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="×" className="rounded p-1 text-faint hover:text-fg"><X size={14} /></button>
      )}
      {have ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-ok"><Check size={13} /> {t("engine.setup.have")}</span>
      ) : (
        <button type="button" onClick={onDownload}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${primary ? "bg-ember text-white" : "border border-line text-fg hover:bg-surface"}`}>
          <Download size={13} /> {t("engine.setup.download")}
        </button>
      )}
    </div>
  );
}

function ModelSearch({ onPick }: { onPick: (view: InspectView) => void }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHitView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<InspectView | null>(null);

  // Typing pauses before asking: one request per thought, not per key.
  useEffect(() => {
    const query = text.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      setBusy(true);
      setFailed(false);
      window.vunemi.engineSearch(query).then(setHits, () => setFailed(true)).finally(() => setBusy(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [text]);

  async function inspect(repo: string) {
    setRefused(null);
    const view = await window.vunemi.engineInspect(repo).catch(() => null);
    if (!view) return setFailed(true);
    if (view.ok) {
      onPick(view);
      setText("");
    } else setRefused(view);
  }

  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
        <Search size={13} className="text-faint" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("engine.search.placeholder")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint" />
        {busy && <Loader2 size={13} className="animate-spin text-faint" />}
      </label>
      {failed && <p className="mt-1.5 text-[12px] text-danger">{t("engine.search.failed")}</p>}
      {refused && !refused.ok && <p className="mt-1.5 text-[12px] text-muted">{refused.repo}: {t(`engine.search.reason.${refused.reason}`)}</p>}
      {hits && hits.length === 0 && <p className="mt-1.5 text-[12px] text-faint">{t("engine.search.none")}</p>}
      {hits && hits.length > 0 && (
        <ul className="mt-1.5 max-h-56 overflow-y-auto scroll-thin">
          {hits.map((h) => (
            <li key={h.repo}>
              <button type="button" onClick={() => void inspect(h.repo)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{h.repo}</span>
                <span className={`inline-flex items-center gap-1 text-[11px] ${h.trusted ? "text-ok" : "text-faint"}`}>
                  {h.trusted && <ShieldCheck size={11} />}{h.trusted ? t("engine.search.trusted") : t("engine.search.community")}
                </span>
                <span className="text-[11px] text-faint">{t("engine.search.downloads", { count: h.downloads })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Installed() {
  const engine = useStore((s) => s.engine)!;
  const refreshProviders = useStore((s) => s.refreshProviders);
  const locale = getLocale();
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function remove(id: string, name: string, size: number) {
    if (!window.confirm(t("engine.installed.confirmRemove", { name, size: formatGB(size, locale) }))) return;
    await window.vunemi.engineRemove(id);
    await refreshProviders();
  }
  async function setContext(id: string, context: number) {
    setError(null);
    await window.vunemi.engineSetContext(id, context).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }
  async function addVision(id: string) {
    setError(null);
    // Progress shows in the download bar; the list updates when it is done.
    await window.vunemi.engineDownload({ vision: id }).catch((e: unknown) =>
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)));
  }
  async function testAgain(id: string) {
    setError(null);
    setTesting(id);
    // Main records the answer, and the list updates from it.
    await window.vunemi.checkModel(`vunemi:${id}`).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    setTesting(null);
  }
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="px-1 pb-1.5 text-[12px] font-medium text-faint">{t("engine.installed.title")}</div>
      {engine.installed.map((m) => (
        <div key={m.id} className="flex items-start gap-2 rounded-lg px-1 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-fg">{m.name}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
              <span className="truncate">
                {formatGB(m.size, locale)}{engine.engine.model === m.id && ` · ${t(`engine.state.${engine.engine.state}`)}`}
              </span>
              {m.vision === "yes" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-px text-muted">
                  <Eye size={11} /> {t("engine.installed.vision")}
                </span>
              )}
              {m.vision === "add" && (
                <button
                  type="button"
                  disabled={engine.download !== null}
                  onClick={() => void addVision(m.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-px text-ember hover:bg-surface-2 disabled:opacity-50"
                >
                  <Eye size={11} /> {t("engine.installed.addVision", { size: m.visionSize ? formatGB(m.visionSize, locale) : "?" })}
                </button>
              )}
            </div>
            <label className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
              {t("engine.installed.context")}
              <select
                value={m.context}
                onChange={(e) => void setContext(m.id, Number(e.target.value))}
                className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg"
              >
                {contextChoices(m.context, m.maxContext).map((n) => {
                  const need = contextMemory(m.weights, m.kvBytesPerToken, n);
                  return <option key={n} value={n}>{need === null ? `${Math.round(n / 1024)}K` : `${Math.round(n / 1024)}K · ≈${formatGB(need, locale)}`}</option>;
                })}
              </select>
              <ContextMemory need={contextMemory(m.weights, m.kvBytesPerToken, m.context)} total={engine.totalMemory} locale={locale} />
            </label>
            {m.toolTest === "failed" && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-danger">
                {t("engine.installed.toolFailed")}
                <button
                  type="button"
                  disabled={testing !== null}
                  onClick={() => void testAgain(m.id)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-surface-2 disabled:opacity-60"
                >
                  {testing === m.id && <Loader2 size={11} className="animate-spin" />} {t("engine.installed.testAgain")}
                </button>
              </div>
            )}
          </div>
          <button type="button" onClick={() => void remove(m.id, m.name, m.size)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2">
            <Trash2 size={12} /> {t("engine.installed.remove")}
          </button>
        </div>
      ))}
      {error && <div className="px-1 pt-1 text-[11.5px] text-danger">{error}</div>}
    </div>
  );
}

/** Above the composer while the chosen built-in model loads or has failed to. */
export function EngineBanner() {
  const engine = useStore((s) => s.engine);
  const model = useStore((s) => s.model);
  if (!engine || !model?.startsWith("vunemi:") || engine.engine.model !== model.slice("vunemi:".length)) return null;
  if (engine.engine.state === "starting") {
    return (
      <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 px-4 text-[12.5px] text-muted">
        <Loader2 size={13} className="animate-spin" /> {t("engine.loading")}
      </div>
    );
  }
  if (engine.engine.state === "failed") {
    return (
      <div className="mx-auto mb-2 w-full max-w-3xl px-4 text-[12.5px] text-danger">
        {t("engine.failed", { error: engine.engine.error ?? "" })} <span className="text-muted">{t("engine.failedHint")}</span>
      </div>
    );
  }
  return null;
}

/** The estimate for the chosen length, and a warning when it won't fit comfortably. */
function ContextMemory({ need, total, locale }: { need: number | null; total: number; locale: string }) {
  if (need === null) return <span className="text-faint">{t("engine.installed.contextHint")}</span>;
  const tight = tooLarge(need, total);
  return (
    <span className={tight ? "text-danger" : "text-faint"}>
      {t(tight ? "engine.installed.memoryTight" : "engine.installed.memory", { need: formatGB(need, locale), total: formatGB(total, locale) })}
    </span>
  );
}
