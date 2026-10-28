import { currentPermissionOffer, permissionTarget } from "../lib/task-permissions.js";
import { BackgroundCapabilitiesCard } from "./BackgroundCapabilitiesCard.js";
import { parseBackgroundCapabilities } from "../lib/background-capabilities.js";
import { useEffect, useState } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Hand,
  MousePointerClick,
  LoaderCircle,
  PencilLine,
  Send,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ActionClass } from "@vunemi/agent-core";
import { currentActionOwner, type CallView } from "../lib/fold.js";
import { actionClassLabel, callDetail, callStatusLabel, formatMs, toolLabel } from "../lib/labels.js";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";
import type { SetupView } from "../../../shared/ipc.js";
import { SetupSummary } from "./AutomationSetup.js";
import { TravelOptionsCard } from "./TravelOptionsCard.js";

const CLASS_ICON: Record<ActionClass, LucideIcon> = {
  read: Eye,
  "write-local": PencilLine,
  destructive: Trash2,
  outbound: Send,
  financial: CreditCard,
};

const CLASS_TONE: Record<ActionClass, string> = {
  read: "text-muted",
  "write-local": "text-ember",
  destructive: "text-danger",
  outbound: "text-warn",
  financial: "text-danger",
};

export function CallCard({ call, showFiles = true, showCapabilities = true, readOnly = false, waitingFor }: { waitingFor?: "approval"|"handoff"; readOnly?: boolean; call: CallView; showFiles?: boolean; showCapabilities?: boolean }) {
  readOnly=readOnly||!call.requestId;
  if (!readOnly && waitingFor === "handoff" && call.handoff) return <HandoffCard call={call} reason={call.handoff} />;
  if (!readOnly && call.status === "awaiting") return call.tool === "automation_create" ? <AutomationSetupCard call={call} /> : <ApprovalCard key={`${call.callId}:${call.taskPermissionOffer?.offerId}:${call.taskPermissionOffer?.revision}`} call={call} />;
  if (!readOnly && call.handoff) return <HandoffCard call={call} reason={call.handoff} />;
  return <><CallRow call={call} showFiles={showFiles} showCapabilities={showCapabilities} />{readOnly&&call.handoff&&<p className="selectable text-[12px] text-muted">{call.handoff}</p>}</>;
}

function CallRow({ call, showFiles, showCapabilities }: { call: CallView; showFiles: boolean; showCapabilities: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = CLASS_ICON[call.actionClass];
  const hasDetail = hasArgs(call.args) || Boolean(call.output);
  const detail = callDetail(call);
  const capabilities = showCapabilities ? parseBackgroundCapabilities(call) : null;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        aria-expanded={open}
      >
        <Icon size={14} className={`shrink-0 ${CLASS_TONE[call.actionClass]}`} strokeWidth={2} />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="text-fg">{toolLabel(call.tool, call.status)}</span>
          {detail && <span className="ml-2 text-faint">{detail}</span>}
        </span>
        <StatusGlyph call={call} />
        {call.durationMs !== undefined && call.status === "ok" && (
          <span className="font-mono text-[11px] tabular-nums text-faint">{formatMs(call.durationMs)}</span>
        )}
        {hasDetail && (
          <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        )}
      </button>
      {capabilities && <div className="border-t border-line px-3 py-2"><BackgroundCapabilitiesCard capabilities={capabilities} /></div>}
      {call.status === "error" && call.output && (
        <p className="selectable border-t border-line px-3 py-2 text-[12px] leading-snug text-danger">
          {call.output.replace(/^Error:\s*/, "")}
        </p>
      )}
      {call.flagged && (
        <p role="alert" className="selectable border-t border-warn-line bg-warn-soft px-3 py-2 text-[12px] leading-snug text-fg">
          <ShieldAlert size={13} className="mr-1.5 -mt-0.5 inline text-warn" />
          {t("call.flagged", { text: call.flagged })}
        </p>
      )}
      {call.artifact && <Shot artifact={call.artifact} />}
      {call.gallery && call.gallery.length > 0 && <Gallery pictures={call.gallery} />}
      {showFiles && call.files && call.files.length > 0 && <Files files={call.files} />}
      <TravelOptionsCard call={call} />
      {open && (
        <div className="selectable space-y-2.5 border-t border-line bg-surface-2/60 px-3 py-2.5">
          <Meta label={t("call.tool")} value={<span className="font-mono">{call.tool}</span>} />
          <Meta label={t("call.class")} value={actionClassLabel(call.actionClass)} />
          {hasArgs(call.args) && <Block label={t("call.input")} text={JSON.stringify(call.args, null, 2)} />}
          {call.output && <Block label={t("call.output")} text={call.output} />}
        </div>
      )}
    </div>
  );
}

/**
 * A scheduled task the model wants to set up. With the automation library on
 * the user approves it on the summary made from its scope, not on a card of
 * the model's own words; without it, or if the summary can't be had, on the
 * card as before.
 */
export function AutomationSetupCard({ call }: { call: CallView }) {
  const decide = useStore((s) => s.decide);
  const renderedOwner=currentActionOwner(useStore.getState(),'approval',call);
  const current=()=>renderedOwner?currentActionOwner(useStore.getState(),'approval',call,renderedOwner):undefined;
  // undefined while it is asked for; null when there is none.
  const [view, setView] = useState<SetupView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired,setExpired]=useState(false);

  useEffect(() => {
    let live = true;
    void window.vunemi.summarizeAutomation(call.args).then(
      (next) => live && setView(next),
      () => live && setView(null),
    );
    return () => {
      live = false;
    };
  }, [call.args]);

  if (view === undefined) return null;
  if (view === null) return <ApprovalCard key={`${call.callId}:${call.taskPermissionOffer?.offerId}:${call.taskPermissionOffer?.revision}`} call={call} />;

  let sending=false;
  const install = async (when?: { time: string; days: number[] }) => {
    const owner=current();if(!owner||busy||expired||sending)return;
    sending=true;
    setBusy(true);
    setError(null);
    try {
      // Kept by the main process and used when the approved call runs.
      if (when){
        const adjusted=await window.vunemi.adjustAutomation(call.args, when,call.callId,owner);
        if(!current())return;
        if(!adjusted){setExpired(true);setBusy(false);return;}
      }
      if(!current())return;
      const accepted=await decide(call.callId, { kind: "approve" },owner);
      if(!current())return;
      if(!accepted){setExpired(true);setBusy(false);}
    } catch (e) {
      if(!current())return;
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="rounded-xl border border-warn-line bg-surface p-4">
      <SetupSummary
        view={view}
        error={error}
        busy={busy||expired}
        onInstall={(when) => void install(when)}
        onCancel={() => {
          const owner=current();if(!owner||busy||expired||sending)return;
          sending=true;
          setBusy(true);setError(null);
          void decide(call.callId, { kind: "reject" },owner).then(ok=>{if(!current())return;if(!ok){setExpired(true);setBusy(false);}}).catch(e=>{if(!current())return;setError(e instanceof Error?e.message:String(e));setBusy(false);});
        }}
      />
      {expired&&<p role="status">{callStatusLabel('cancelled')}</p>}
    </div>
  );
}

export function ApprovalCard({ call }: { call: CallView }) {
  const renderedOwner=currentActionOwner(useStore.getState(),'approval',call);
  const current=()=>renderedOwner?currentActionOwner(useStore.getState(),'approval',call,renderedOwner):undefined;
  const offer=useStore(s=>currentPermissionOffer(s,call));
  const [scope,setScope]=useState<"once"|"run">("once");
  const decide = useStore((s) => s.decide);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired,setExpired]=useState(false);
  const Icon = CLASS_ICON[call.actionClass];
  const args = call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {};
  const exports = Array.isArray(args.outputs) ? args.outputs.flatMap(value =>
    value && typeof value === "object" && typeof (value as Record<string, unknown>).path === "string" ? [(value as Record<string, unknown>).path] : []) : [];
  const target = [args.app, args.windowTitle, ...(exports.length ? exports : [args.out ?? args.path]), args.account, args.to]
    .flatMap(v => typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [])
    .join(" · ");

  let sending=false;
  const act = (kind: "approve" | "approve_always" | "reject") => {
    const owner=current();
    if(!owner||busy||expired||sending)return;
    if(kind==="approve"&&scope==="run"&&!offer)return;
    sending=true;
    setBusy(true);
    setError(null);
    const scoped=kind==="approve"&&scope==="run"&&offer;
    const pending=scoped ? useStore.getState().approveTaskPermission(call.callId,offer!) : decide(call.callId, { kind },owner);
    void pending.then(ok=>{if(!current())return;if(!scoped&&ok===false){setExpired(true);setBusy(false);}}).catch((e: unknown) => {
      if(!current())return;
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div role="alert" className="rounded-xl border border-warn-line bg-warn-soft p-3.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-warn">
        <Hand size={14} strokeWidth={2.2} />
        {call.switchedOff ? t("call.switchedOffTitle") : t("call.approvalNeeded")}
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-warn-line px-2 py-px text-[11px] font-normal">
          <Icon size={11} />
          {actionClassLabel(call.actionClass)}
        </span>
      </div>
      <p className="mt-2 text-[14px] font-medium text-fg">{toolLabel(call.tool, "awaiting")}</p>
      {target && <p className="selectable mt-1 break-words text-[13px] text-muted"><span className="font-medium">{t("approvalContext.target")}:</span> {target}</p>}
      {call.switchedOff && call.reason && <p className="mt-1 text-[12.5px] leading-snug text-muted">{call.reason}</p>}
      {call.alert && call.reason && (
        <p className="selectable mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] leading-snug text-fg">
          <ShieldAlert size={13} className="mr-1.5 -mt-0.5 inline text-danger" />
          {call.reason}
        </p>
      )}
      {call.preview ? (
        <div className="mt-2 rounded-lg bg-surface/70 px-3 py-2"><p className="text-[12px] font-medium text-muted">{t("approvalContext.change")}</p><p className="selectable mt-1 whitespace-pre-wrap break-words text-[13px] text-fg">{call.preview}</p></div>
      ) : (
        hasArgs(call.args) && <ArgsPreview args={call.args} />
      )}
      {call.tool === "shortcuts_run" && <ShowShortcut args={call.args} />}
      {offer && <fieldset disabled={busy||expired||!call.requestId} className="mt-3 space-y-2 text-[12px] text-fg">
        <legend className="mb-1 font-medium">{t("taskPermissions.scopeLegend")}</legend>
        <label className="flex items-start gap-2"><input type="radio" name={`scope-${call.callId}`} checked={scope==="once"} onChange={()=>setScope("once")} />{t("taskPermissions.once")}</label>
        <label className="flex items-start gap-2"><input type="radio" name={`scope-${call.callId}`} checked={scope==="run"} onChange={()=>setScope("run")} />{t(offer.effect==='file-read'?"taskPermissions.fileOffer":"taskPermissions.windowOffer")}</label>
        <p className="selectable break-words text-muted"><bdi>{permissionTarget(offer.target)}</bdi></p>
        {offer.effect==='file-read'&&<p className="text-muted">{t("taskPermissions.fileSameVersion")}</p>}
      </fieldset>}
      <p className="mt-2 text-[12px] leading-relaxed text-muted">{t("approvalContext.once")}</p>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      {expired&&<p role="status">{callStatusLabel('cancelled')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* No autoFocus: a stray Enter while typing must never grant an action. */}
        <button
          type="button"
          disabled={busy||expired||!call.requestId}
          onClick={() => act("approve")}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {call.switchedOff ? t("call.switchOnce") : t("call.approve")}
        </button>
        {call.switchedOff && (
          <button
            type="button"
            disabled={busy||expired||!call.requestId}
            onClick={() => act("approve_always")}
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {call.switchedOff ? t("call.switchAlways") : t("call.approveAlways")}
          </button>
        )}
        <button
          type="button"
          disabled={busy||expired||!call.requestId}
          onClick={() => act("reject")}
          className="rounded-lg px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          {call.switchedOff ? t("call.keepOff") : t("call.reject")}
        </button>
      </div>
    </div>
  );
}

/** The agent is waiting for the user to do something only they should do. */
/**
 * A picture the agent took. It is loaded through main rather than a file URL:
 * the renderer's policy allows no local files, and relaxing that so a window
 * can show a screenshot would be a poor trade.
 */
/** Vunemi can't see inside a shortcut; the user can, in Shortcuts, before deciding. */
function ShowShortcut({ args }: { args: unknown }) {
  const [error, setError] = useState<string | null>(null);
  const name = typeof args === "object" && args !== null && typeof (args as { name?: unknown }).name === "string" ? (args as { name: string }).name : "";
  if (!name) return null;
  const show = () => {
    setError(null);
    window.vunemi.showShortcut(name).catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)));
  };
  return (
    <div className="mt-2">
      <button type="button" onClick={show} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-muted hover:bg-surface hover:text-fg">
        <ExternalLink size={12} /> {t("apps.shortcuts.show")}
      </button>
      {error && <p role="alert" className="mt-1 text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

/** What the call wrote, openable right here rather than only from Artefacts. */
function Files({ files }: { files: { id: string; name: string }[] }) {
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)));
  };
  return (
    <div className="border-t border-line px-3 py-2">
      {files.map((file) => (
        <div key={file.id} className="flex items-center gap-2 py-0.5 text-[12.5px]">
          <FileText size={13} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate text-fg">{file.name}</span>
          {/\.html?$/i.test(file.name) ? (
            <button type="button" onClick={() => act(() => useStore.getState().showPreview(file.id))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-fg">
              <Eye size={12} /> {t("artefacts.preview")}
            </button>
          ) : (
            <button type="button" onClick={() => act(() => window.vunemi.openArtefact(file.id))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-fg">
              <ExternalLink size={12} /> {t("common.open")}
            </button>
          )}
          <button type="button" onClick={() => act(() => window.vunemi.revealArtefact(file.id))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-fg">
            <FolderOpen size={12} /> {t("artefacts.reveal")}
          </button>
        </div>
      ))}
      {error && <p role="alert" className="mt-1 text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

/** A picture from Vunemi's own folder, as a data URL; null until read, or if it can't be. */
function usePicture(path: string): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void window.vunemi
      .readImage(path)
      .then((url) => live && setSrc(url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [path]);
  return { src, failed };
}

/** Found photos as small tiles; one click shows it large beside the chat. */
function Gallery({ pictures }: { pictures: { path: string; label?: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 border-t border-line bg-surface-2/40 p-2 sm:grid-cols-6">
      {pictures.map((picture) => <Tile key={picture.path} picture={picture} />)}
    </div>
  );
}

function Tile({ picture }: { picture: { path: string; label?: string } }) {
  const show = useStore((s) => s.showPicture);
  const { src, failed } = usePicture(picture.path);
  if (failed) return null;
  return (
    <button
      type="button"
      onClick={() => show(picture)}
      title={picture.label}
      aria-label={picture.label ?? t("call.picture")}
      className="aspect-square overflow-hidden rounded-md bg-surface-3 outline-none ring-ember focus-visible:ring-2"
    >
      {src ? <img src={src} alt="" className="size-full object-cover transition-transform hover:scale-105" /> : <div className="size-full animate-pulse" />}
    </button>
  );
}

function Shot({ artifact }: { artifact: { path: string; label?: string } }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void window.vunemi
      .readImage(artifact.path)
      .then((url) => live && setSrc(url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [artifact.path]);

  if (failed) return null;
  return (
    <figure className="border-t border-line bg-surface-2/40 p-2">
      {src ? (
        <img src={src} alt={artifact.label ?? t("call.screenshot")} className="max-h-[340px] w-full rounded-md object-contain" />
      ) : (
        <div className="h-24 animate-pulse rounded-md bg-surface-3" />
      )}
      {artifact.label && <figcaption className="mt-1.5 text-[11.5px] text-faint">{artifact.label}</figcaption>}
    </figure>
  );
}

export function HandoffCard({ call, reason }: { call: CallView; reason: string }) {
  const renderedOwner=currentActionOwner(useStore.getState(),'handoff',call);
  const current=()=>renderedOwner?currentActionOwner(useStore.getState(),'handoff',call,renderedOwner):undefined;
  const resolve = useStore((s) => s.resolveHandoff);
  const [busy, setBusy] = useState(false);
  const [error,setError]=useState<string|null>(null),[expired,setExpired]=useState(false);
  let sending=false;
  const act = (outcome: "done" | "cancelled") => {
    const owner=current();if(!owner||busy||expired||sending)return;
    sending=true;
    setBusy(true);
    setError(null);
    void resolve(call.callId, outcome,owner).then(ok=>{if(!current())return;if(!ok){setExpired(true);setBusy(false);}}).catch(e=>{if(!current())return;setError(e instanceof Error?e.message:String(e));setBusy(false);});
  };

  return (
    <div role="alert" className="rounded-xl border border-ember/40 bg-ember-soft p-3.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-ember">
        <MousePointerClick size={14} strokeWidth={2.2} />
        {t("call.yourTurn")}
      </div>
      <p className="selectable mt-2 text-[14px] leading-snug text-fg">{reason}</p>
      {error&&<p role="alert">{error}</p>}
      {expired&&<p role="status">{callStatusLabel('cancelled')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy||expired||!call.requestId}
          onClick={() => act("done")}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t("call.doneContinue")}
        </button>
        <button
          type="button"
          disabled={busy||expired||!call.requestId}
          onClick={() => act("cancelled")}
          className="rounded-lg px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function StatusGlyph({ call }: { call: CallView }) {
  const label = callStatusLabel(call.status);
  switch (call.status) {
    case "running":
    case "proposed":
      return <LoaderCircle size={13} className="shrink-0 animate-spin text-muted" aria-label={label} />;
    case "ok":
      return <Check size={14} className="shrink-0 text-ok" aria-label={label} strokeWidth={2.4} />;
    case "error":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-danger">
          <TriangleAlert size={12} /> {label}
        </span>
      );
    case "interrupted":
      return <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-muted"><TriangleAlert size={12} className="text-warn" />{label}</span>;
    case "cancelled":
    case "rejected":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-muted">
          <Ban size={12} /> {label}
        </span>
      );
    default:
      return null;
  }
}

function ArgsPreview({ args }: { args: unknown }) {
  const entries = Object.entries(args as Record<string, unknown>);
  return (
    <dl className="selectable mt-2 space-y-1 rounded-lg bg-surface/70 px-3 py-2 text-[12.5px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-3">
          <dt className="w-20 shrink-0 font-mono text-faint">{k}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-fg">{previewValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[12px]">
      <span className="w-14 shrink-0 text-faint">{label}</span>
      <span className="text-muted">{value}</span>
    </div>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
      <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
        {text}
      </pre>
    </div>
  );
}

function hasArgs(args: unknown): boolean {
  return typeof args === "object" && args !== null && Object.keys(args).length > 0;
}

function previewValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
}
