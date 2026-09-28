import { useEffect, useRef, useState } from "react";
import { AudioLines, Hand, ListChecks, Loader, Mic, ShieldQuestion, Volume2, X } from "lucide-react";
import { pendingApprovals, pendingHandoff, planAwaiting } from "../lib/fold.js";
import { useStore, type VoiceState } from "../store.js";
import { t } from "@vunemi/i18n";

/** How many bars the waveform keeps; at ~55 ms a frame this is ~1.5 seconds. */
const BARS = 28;

type Phase = VoiceState | "acting" | "handoff" | "approval" | "plan";


/**
 * Whose turn it is, said plainly, right above the composer where the user is
 * already looking. Waiting for the user outranks everything: a run stopped at
 * a bot check is not "working", and the timeline card that says so can be
 * scrolled out of sight.
 *
 * "Uyguluyor" is only for turns that began by speaking — a typed task already
 * shows its progress in the timeline, and a second banner is just noise.
 */
export function VoiceBar() {
  const state = useStore((s) => s.voice.state);
  const running = useStore((s) => s.running);
  const voiceTurn = useStore((s) => s.voice.turn);
  const runs = useStore((s) => s.runs);

  const handoff = pendingHandoff(runs);
  const approvals = pendingApprovals(runs);
  const plan = planAwaiting(runs);
  const phase: Phase = handoff
    ? "handoff"
    : plan
      ? "plan"
      : approvals > 0
      ? "approval"
      : state !== "off"
        ? state
        : running && voiceTurn
          ? "acting"
          : "off";
  if (phase === "off") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2"
    >
      <Glyph phase={phase} />
      <span className="shrink-0 text-[12.5px] font-medium text-fg">{t(`voice.phase.${phase}`)}</span>
      {phase === "listening" ? (
        <Heard />
      ) : phase === "handoff" ? (
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={handoff!.reason}>
          {handoff!.reason}
        </p>
      ) : phase === "approval" ? (
        <p className="min-w-0 flex-1 text-[12.5px] text-muted">
          {t("voice.approvals", { count: approvals })}
        </p>
      ) : phase === "plan" ? (
        <p className="min-w-0 flex-1 text-[12.5px] text-muted">{t("voice.planHint")}</p>
      ) : (
        <Shimmer phase={phase} />
      )}
      <Trailer phase={phase} handoffId={handoff?.callId ?? null} />
    </div>
  );
}

function Glyph({ phase }: { phase: Exclude<Phase, "off"> }) {
  switch (phase) {
    case "listening":
      // The unmissable "your microphone is open" light.
      return (
        <span className="relative grid size-5 shrink-0 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-danger/30" />
          <Mic size={13} className="relative text-danger" />
        </span>
      );
    case "thinking":
      return <Loader size={14} className="shrink-0 animate-spin text-muted" />;
    case "speaking":
      return <Volume2 size={14} className="shrink-0 text-ember" />;
    case "acting":
      return <AudioLines size={14} className="shrink-0 text-ember" />;
    case "handoff":
      return <Hand size={14} className="shrink-0 text-ember" />;
    case "approval":
      return <ShieldQuestion size={14} className="shrink-0 text-ember" />;
    case "plan":
      return <ListChecks size={14} className="shrink-0 text-ember" />;
  }
}

/**
 * While listening: the waveform until there are words, then the words. The
 * running transcript is the better signal — it shows not just that Vunemi is
 * hearing something but what it thinks it heard.
 */
function Heard() {
  const partial = useStore((s) => s.voice.partial);
  if (!partial) return <Wave />;
  return (
    <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={partial}>
      {partial}
    </p>
  );
}

/** The microphone, drawn. Bars scroll right to left as you speak. */
function Wave() {
  const level = useStore((s) => s.voice.level);
  const [bars, setBars] = useState<number[]>(() => Array<number>(BARS).fill(0));
  const last = useRef(0);

  useEffect(() => {
    // One entry per reported level, so the bars move with the voice.
    if (level === last.current) return;
    last.current = level;
    setBars((prev) => [...prev.slice(1), level]);
  }, [level]);

  return (
    <div className="flex h-5 flex-1 items-center gap-[2px]" aria-hidden>
      {bars.map((v, i) => (
        <span
          key={i}
          className="flex-1 rounded-full bg-danger/70 transition-[height] duration-75"
          style={{ height: `${Math.max(2, v * 20)}px` }}
        />
      ))}
    </div>
  );
}

/** Thinking and speaking have no signal to show, so they get motion instead. */
function Shimmer({ phase }: { phase: Phase }) {
  const tone = phase === "speaking" ? "bg-ember/60" : "bg-muted/40";
  return (
    <div className="flex h-5 flex-1 items-center gap-[2px]" aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className={`flex-1 animate-pulse rounded-full ${tone}`}
          style={{
            height: `${4 + Math.abs(Math.sin(i * 0.7)) * (phase === "speaking" ? 14 : 6)}px`,
            animationDelay: `${i * 40}ms`,
          }}
        />
      ))}
    </div>
  );
}

function Trailer({ phase, handoffId }: { phase: Phase; handoffId: string | null }) {
  const { finishListening, cancelListening, resolveHandoff } = useStore();
  const handsFree = useStore((s) => s.voice.handsFree);

  if (phase === "handoff" && handoffId) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void resolveHandoff(handoffId, "done")}
          className="rounded-md bg-ember px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
        >
          {t("call.doneContinue")}
        </button>
        <button
          type="button"
          onClick={() => void resolveHandoff(handoffId, "cancelled")}
          className="rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-fg transition-colors hover:bg-surface-2"
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  if (phase === "listening") {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] text-faint">{t(handsFree ? "voice.endsOnSilence" : "voice.tapWhenDone")}</span>
        <button
          type="button"
          onClick={() => void finishListening(handsFree)}
          className="rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-fg transition-colors hover:bg-surface-2"
        >
          {t("voice.done")}
        </button>
        <button
          type="button"
          onClick={cancelListening}
          aria-label={t("common.cancel")}
          title={t("voice.cancelEsc")}
          className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (phase === "speaking") {
    return (
      <button
        type="button"
        onClick={() => cancelListening()}
        className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-fg transition-colors hover:bg-surface-2"
      >
        {t("voice.stopTalking")}
      </button>
    );
  }

  // Transcribing: still the user's turn to be able to walk away from it.
  if (phase === "thinking") {
    return (
      <button
        type="button"
        onClick={cancelListening}
        aria-label={t("common.cancel")}
        title={t("voice.cancelEsc")}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <X size={12} />
      </button>
    );
  }

  return null;
}
