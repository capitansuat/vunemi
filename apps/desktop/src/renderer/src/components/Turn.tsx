import { useEffect, useState } from "react";
import { ChevronRight, CircleStop, FileText, TriangleAlert } from "lucide-react";
import { Mochi } from "./Mochi.js";
import { runStats, type CompactionView, type RunView, type StepView } from "../lib/fold.js";
import { formatMs, formatTokens, runStatusLabel, shortModelName } from "../lib/labels.js";
import { CallCard } from "./CallCard.js";
import { PlanCard } from "./PlanCard.js";
import { Markdown } from "./Markdown.js";
import { t } from "@vunemi/i18n";

/** One exchange: what the user asked, and everything the agent did about it. */
export function Turn({ run }: { run: RunView }) {
  const live = run.status === "running";
  const last = run.steps.at(-1);
  // The answer is the final step's text; earlier steps' text is narration.
  // A run that ran out of steps still answers, with what it found.
  const answerStep = !live && (run.status === "done" || (run.status === "max_steps" && answered(last))) ? last : undefined;

  return (
    <section className="space-y-4">
      <div className="flex flex-col items-end gap-1.5">
        {run.attachments && (
          <ul className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {run.attachments.map((path) => (
              <li key={path} title={path} className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-muted">
                <FileText size={13} className="shrink-0" />
                <span className="truncate">{path.split("/").pop()}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-[14.5px] leading-relaxed text-fg">
          {run.goal}
        </div>
      </div>

      <div className="space-y-2.5">
        {run.plan && <PlanCard plan={run.plan} />}
        {run.steps.map((step) => (
          <Step
            key={step.stepId}
            step={step}
            streaming={live && step === last}
            isAnswer={step === answerStep}
          />
        ))}
        {live && run.plan?.status !== "awaiting" && (!last || isEmpty(last)) && (
          // Before the first token a local model reads the whole
          // conversation, and after a tool result that can take a minute.
          // Say what is happening, and for how long, rather than leave the
          // user to wonder whether it is stuck.
          <Starting
            planning={run.plan === undefined && run.steps.length === 0}
            afterTool={(last?.index ?? 0) > 0}
            since={last?.startedAt ?? run.startedAt}
          />
        )}
        {!live && run.status !== "done" && <Ending run={run} />}
      </div>

      {!live && <Footer run={run} />}
      {run.compaction && <Compaction c={run.compaction} />}
    </section>
  );
}

function Compaction({ c }: { c: CompactionView }) {
  const [open, setOpen] = useState(false);
  if (c.status === "running") {
    return <p className="mt-2 text-[11.5px] text-faint">{t("context.summarizing")}</p>;
  }
  const label = t(c.kind === "summarized" ? "context.summarized" : "context.pruned", {
    before: formatTokens(c.before),
    after: formatTokens(c.after),
  });
  return (
    <div className="mt-2 text-[11.5px] text-faint">
      <span>{label}</span>
      {c.summary && (
        <>
          {" · "}
          <button type="button" className="underline decoration-dotted hover:text-muted" onClick={() => setOpen(!open)}>
            {open ? t("context.hideSummary") : t("context.showSummary")}
          </button>
          {open && <pre className="selectable mt-1.5 whitespace-pre-wrap rounded-md bg-surface-2 p-2.5 font-sans text-[12px] text-muted">{c.summary}</pre>}
        </>
      )}
    </div>
  );
}

function Step({ step, streaming, isAnswer }: { step: StepView; streaming: boolean; isAnswer: boolean }) {
  const thinking = streaming && step.thought !== "" && step.text === "" && step.calls.length === 0;
  return (
    <div className="space-y-2">
      {step.thought !== "" && <Thought text={step.thought} active={thinking} />}
      {step.text.trim() !== "" &&
        (isAnswer || (streaming && step.calls.length === 0) ? (
          <Markdown text={step.text} />
        ) : (
          <p className="selectable whitespace-pre-wrap text-[13.5px] text-muted">{step.text.trim()}</p>
        ))}
      {step.calls.map((c) => (
        <CallCard key={c.callId} call={c} />
      ))}
    </div>
  );
}

function Thought({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-1 text-[12.5px] text-faint transition-colors hover:text-muted"
        aria-expanded={open}
      >
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        <span className={active ? "shimmer" : ""}>{active ? t("turn.thinking") : t("turn.thoughts")}</span>
      </button>
      {open && (
        <div className="selectable mt-1.5 ml-[5px] max-h-72 overflow-auto whitespace-pre-wrap border-l border-line pl-3.5 text-[12.5px] leading-relaxed text-faint scroll-thin">
          {text.trim()}
        </div>
      )}
    </div>
  );
}

function Starting({ planning, afterTool, since }: { planning: boolean; afterTool: boolean; since: number }) {
  const seconds = useSecondsSince(since);
  const label = planning ? t("turn.planning") : afterTool ? t("turn.readingResult") : t("turn.readingTask");
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-faint">
      <span className="ember-pulse inline-block size-2 rounded-full bg-ember" />
      <span className="shimmer">{label}</span>
      {/* Only once it is long enough to wonder about. */}
      {seconds >= 3 && <span className="tabular-nums">{t("time.seconds", { n: seconds })}</span>}
    </div>
  );
}

function useSecondsSince(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** A last step that says something and asks for nothing: an answer. */
function answered(step: StepView | undefined): boolean {
  return step !== undefined && step.text.trim() !== "" && step.calls.length === 0;
}

function Ending({ run }: { run: RunView }) {
  if (run.status === "max_steps" && answered(run.steps.at(-1))) {
    return <p className="text-[12.5px] text-muted">{t("turn.stepLimit")}</p>;
  }
  if (run.status === "stopped") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <CircleStop size={14} /> {t("turn.stopped")}
      </div>
    );
  }
  const unreachable = run.detail?.startsWith("Cannot reach");
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-danger">
        <TriangleAlert size={14} /> {runStatusLabel(run.status)}
      </div>
      <p className="selectable mt-1 text-[12.5px] text-muted">
        {unreachable
          ? t("turn.unreachable")
          : run.detail}
      </p>
    </div>
  );
}

function Footer({ run }: { run: RunView }) {
  const s = runStats(run);
  const parts = [
    t("turn.steps", { count: s.steps }),
    s.tools > 0 ? t("turn.tools", { count: s.tools }) : null,
    s.tokensPerSec !== null ? t("turn.tokensPerSec", { n: s.tokensPerSec }) : null,
    s.ttftMs !== null ? t("turn.firstToken", { time: formatMs(s.ttftMs) }) : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
      <Mochi size={12} face={false} className="text-ember/70" />
      <span className="font-medium text-muted">{shortModelName(run.model)}</span>
      <span>·</span>
      <span className="tabular-nums">{parts.join(" · ")}</span>
    </div>
  );
}

function isEmpty(s: StepView): boolean {
  return s.thought === "" && s.text === "" && s.calls.length === 0;
}
