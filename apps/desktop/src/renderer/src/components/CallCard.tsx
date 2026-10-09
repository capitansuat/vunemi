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
import type { CallView } from "../lib/fold.js";
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

export function CallCard({ call }: { call: CallView }) {
  if (call.status === "awaiting") return call.tool === "automation_create" ? <AutomationSetupCard call={call} /> : <ApprovalCard call={call} />;
  if (call.handoff) return <HandoffCard call={call} reason={call.handoff} />;
  return <CallRow call={call} />;
}

function CallRow({ call }: { call: CallView }) {
  const [open, setOpen] = useState(false);
  const Icon = CLASS_ICON[call.actionClass];
  const hasDetail = hasArgs(call.args) || Boolean(call.output);
  const detail = callDetail(call);

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
      {call.files && call.files.length > 0 && <Files files={call.files} />}
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
function AutomationSetupCard({ call }: { call: CallView }) {
  const decide = useStore((s) => s.decide);
  // undefined while it is asked for; null when there is none.
  const [view, setView] = useState<SetupView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  if (view === null) return <ApprovalCard call={call} />;

  const install = async (when?: { time: string; days: number[] }) => {
    setBusy(true);
    setError(null);
    try {
      // Kept by the main process and used when the approved call runs.
      if (when) await window.vunemi.adjustAutomation(call.args, when);
      await decide(call.callId, { kind: "approve" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="rounded-xl border border-warn-line bg-surface p-4">
      <SetupSummary
        view={view}
        error={error}
        busy={busy}
        onInstall={(when) => void install(when)}
        onCancel={() => {
          setBusy(true);
          void decide(call.callId, { kind: "reject" });
        }}
      />
    </div>
  );
}

function ApprovalCard({ call }: { call: CallView }) {
  const decide = useStore((s) => s.decide);
  const [busy, setBusy] = useState(false);
  const Icon = CLASS_ICON[call.actionClass];

  const act = (kind: "approve" | "approve_always" | "reject") => {
    setBusy(true);
    void decide(call.callId, kind === "reject" ? { kind } : { kind });
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
      {call.switchedOff && call.reason && <p className="mt-1 text-[12.5px] leading-snug text-muted">{call.reason}</p>}
      {call.alert && call.reason && (
        <p className="selectable mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] leading-snug text-fg">
          <ShieldAlert size={13} className="mr-1.5 -mt-0.5 inline text-danger" />
          {call.reason}
        </p>
      )}
      {call.preview ? (
        <p className="selectable mt-2 break-words rounded-lg bg-surface/70 px-3 py-2 font-mono text-[12.5px] text-fg">
          {call.preview}
        </p>
      ) : (
        hasArgs(call.args) && <ArgsPreview args={call.args} />
      )}
      {call.tool === "shortcuts_run" && <ShowShortcut args={call.args} />}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* No autoFocus: a stray Enter while typing must never grant an action. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => act("approve")}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {call.switchedOff ? t("call.switchOnce") : t("call.approve")}
        </button>
        {(call.switchedOff || !call.alwaysAsk) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act("approve_always")}
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {call.switchedOff ? t("call.switchAlways") : t("call.approveAlways")}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
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

function HandoffCard({ call, reason }: { call: CallView; reason: string }) {
  const resolve = useStore((s) => s.resolveHandoff);
  const [busy, setBusy] = useState(false);
  const act = (outcome: "done" | "cancelled") => {
    setBusy(true);
    void resolve(call.callId, outcome);
  };

  return (
    <div role="alert" className="rounded-xl border border-ember/40 bg-ember-soft p-3.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-ember">
        <MousePointerClick size={14} strokeWidth={2.2} />
        {t("call.yourTurn")}
      </div>
      <p className="selectable mt-2 text-[14px] leading-snug text-fg">{reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => act("done")}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t("call.doneContinue")}
        </button>
        <button
          type="button"
          disabled={busy}
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
