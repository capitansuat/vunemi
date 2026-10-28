import {SelectionFollowup} from './SelectionFollowup.js';
import {quoteSourceAnchor,type QuoteOrigin} from '../lib/selection-followup.js';
import { BackgroundCapabilitiesCard } from "./BackgroundCapabilitiesCard.js";
import { parseBackgroundCapabilities } from "../lib/background-capabilities.js";
import { copyAnswer } from "../lib/coordinated-design.js";
import { taskSummary } from "../lib/task-summary.js";
import { memo, useEffect, useState } from "react";
import { ChevronRight, CircleStop, FileText, TriangleAlert } from "lucide-react";
import { Mochi } from "./Mochi.js";
import { activeTurnAction, draftText, runStats, type CompactionView, type RunView, type StepView } from "../lib/fold.js";
import { formatMs, formatTokens, runStatusLabel, shortModelName } from "../lib/labels.js";
import { CallCard } from "./CallCard.js";
import { MentionIcon } from "./MentionMenu.js";
import { ChoiceCard } from "./ChoiceCard.js";
import { TaskSummary } from "./TaskSummary.js";
import type { TaskRecord } from "@vunemi/agent-core";
import { PlanCard } from "./PlanCard.js";
import { MemoryNotice, MemoryProposals } from "./MemoryNotes.js";
import { SavedNotes } from "./WorkNotes.js";
import { Markdown } from "./Markdown.js";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";
import {attentionTaskAnchor,focusAttentionTarget} from '../lib/task-attention.js';

/** One exchange: what the user asked, and everything the agent did about it. */
export const Turn = memo(function Turn({ run, replies, task, recovery = false, active = false }: { active?: boolean; run: RunView; replies?: string[]; task?: TaskRecord; recovery?: boolean }) {
  useStore(s => s.locale);
  const sessionId=useStore(s=>s.sessions.current);
  const attentionTarget=useStore(s=>s.attentionTarget);
  useEffect(()=>{
    if(!attentionTarget||!task||attentionTarget.taskId!==task.id||attentionTarget.runId!==run.runId)return;
    const frame=requestAnimationFrame(()=>{
      const state=useStore.getState();
      focusAttentionTarget(attentionTarget,{sessionId:state.sessions.current,taskId:task.id,runId:run.runId,current:state.attentionTarget},document.getElementById(attentionTaskAnchor(task.id)));
    });
    return ()=>cancelAnimationFrame(frame);
  },[attentionTarget,task?.id,run.runId]);
  const live = run.status === "running";
  const last = run.steps.at(-1);
  // The answer is the final step's text; earlier steps' text is narration.
  // A run that ran out of steps still answers, with what it found.
  const answerStep = !live && (run.status === "done" || (run.status === "max_steps" && answered(last))) ? last : undefined;
  const currentStep = live ? last : answerStep ?? last;
  const foreground = task ? run.steps.filter(step => step === currentStep || step.calls.some(call => call.status === "awaiting" || call.handoff) || step.choices.some(choice => choice.status === "awaiting")) : run.steps;
  const history = task ? run.steps.filter(step => !foreground.includes(step)) : [];
  const showFiles = !task || task.waitingPlan || task.outputs.length === 0;
  // Only the latest describe can speak for this run; an error must not revive an older observation.
  const latestDescribe = run.steps.flatMap(step => step.calls).filter(call => ["desktop_background_describe","page_target_observe"].includes(call.tool)).at(-1);
  const latestCapabilities = latestDescribe ? parseBackgroundCapabilities(latestDescribe) : null;
  const promoteCapabilities = Boolean(latestCapabilities && history.some(step => step.calls.includes(latestDescribe!)));
  const visibleCapabilityCallId = promoteCapabilities ? undefined : latestDescribe?.callId;
  const action=activeTurnAction(run,active);
  const excludedCalls = new Set(action?.kind==='approval'||action?.kind==='handoff'?[action.call.callId]:[]);
  const excludedChoices = new Set(action?.kind==='choice'?[action.choice.callId]:[]);

  return (
    <section className="space-y-4">
      <div className="flex flex-col items-end gap-1.5">
        {(run.attachments || run.mentions) && (
          <ul className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {run.mentions?.map((m) => (
              <li key={`${m.kind}:${m.id}`} title={m.title} className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-muted">
                <MentionIcon kind={m.kind} />
                <span className="truncate">{m.title}</span>
              </li>
            ))}
            {run.attachments?.map((path) => (
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
        {run.quotedSource && <div className="max-w-[80%] rounded-lg border border-line bg-surface-2 p-3 text-[12px] text-muted"><a href={`#${quoteSourceAnchor(run.quotedSource.runId,run.quotedSource.stepId)}`} className="underline decoration-dotted">{t('quotedSource.source')}</a><blockquote className="selectable mt-1 whitespace-pre-wrap break-words border-l-2 border-line-strong pl-2">{run.quotedSource.text}</blockquote></div>}
      </div>

      <div className="space-y-2.5">
        {task && <TaskSummary task={task} recovery={recovery} anchor={!task.waitingPlan||action?.kind!=='plan'} />}
        {promoteCapabilities && latestCapabilities && <BackgroundCapabilitiesCard capabilities={latestCapabilities} />}
        {run.plan && action?.kind!=="plan" && (run.plan.status !== "accepted" || !task) && <PlanCard plan={run.plan} readOnly />}
        {history.length > 0 && <details className="group rounded-lg px-1 py-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-[12px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-ember"><ChevronRight size={12} aria-hidden="true" className="group-open:rotate-90" />{t("chatTask.history")}</summary>
          <div className="mt-3 space-y-3">{history.map(step => <Step key={step.stepId} step={step} streaming={false} isAnswer={false} showFiles={showFiles} excludedCalls={excludedCalls} excludedChoices={excludedChoices} capabilityCallId={visibleCapabilityCallId} />)}</div>
        </details>}
        {foreground.map((step) => (
          <Step key={step.stepId} step={step} streaming={live && step === last} isAnswer={step === answerStep} quoteOrigin={step===answerStep?{sessionId,runId:run.runId,stepId:step.stepId,raw:step.text}:undefined} showFiles={showFiles} excludedCalls={excludedCalls} excludedChoices={excludedChoices} capabilityCallId={visibleCapabilityCallId} />
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
        {!live && run.status !== "done" && !(run.status === "stopped" && task && taskSummary(task).show) && <Ending run={run} />}
        {answerStep && <AnswerActions text={answerStep.text} />}
        {replies && <Replies options={replies} />}
      </div>

      {!live && <Footer run={run} />}
      {run.lowered && <Lowered l={run.lowered} />}
      {!live && run.memory && run.memory.given.length > 0 && <MemoryNotice notes={run.memory.given} />}
      {run.memory && run.memory.proposals.length > 0 && <MemoryProposals runId={run.runId} proposals={run.memory.proposals} />}
      {run.notes && run.notes.length > 0 && <SavedNotes notes={run.notes} />}
      {run.compaction && <Compaction c={run.compaction} />}
      {action && <div data-turn-actions id={task?.waitingPlan&&action.kind==='plan'?attentionTaskAnchor(task.id):undefined} data-task-id={task?.waitingPlan&&action.kind==='plan'?task.id:undefined} tabIndex={task?.waitingPlan&&action.kind==='plan'?-1:undefined} aria-label={task?.waitingPlan&&action.kind==='plan'?task.goal:undefined} className="space-y-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ember">
        {action.kind==='plan'?<PlanCard key={`${run.runId}:plan:${action.plan.requestId??'history'}`} plan={action.plan}/>:action.kind==='choice'?<ChoiceCard key={`${run.runId}:choice:${action.choice.callId}:${action.choice.requestId??'history'}`} choice={action.choice}/>:<CallCard key={`${run.runId}:${action.kind}:${action.call.callId}:${action.call.requestId??'history'}`} call={action.call} waitingFor={action.kind} showFiles={showFiles}/>}
      </div>}
    </section>
  );
});

/**
 * The answer ended on "which one?": its items, to answer with a click.
 * Nothing waits on them. They are there while the answer is the last word
 * of the conversation, and a click sends the item as the next message.
 */
function Replies({ options }: { options: string[] }) {
  const busy = useStore((s) => s.running || s.pendingStart !== null);
  const send = useStore((s) => s.send);
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option, index) => (
        <button key={index} type="button" disabled={busy} onClick={() => void send(option).catch(() => undefined)}
          className="rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-fg hover:border-ember hover:bg-ember/10 disabled:cursor-default disabled:opacity-60">
          {option}
        </button>
      ))}
    </div>
  );
}

/** The model opened with a shorter context for lack of memory; it changes how much this conversation keeps in view. */
function Lowered({ l }: { l: NonNullable<RunView["lowered"]> }) {
  const parts = [
    ...(l.context < l.wanted ? [t("context.lowered", { context: formatTokens(l.context), wanted: formatTokens(l.wanted) })] : []),
    ...(l.tight ? [t("context.tight")] : []),
  ];
  return <p className="mt-2 text-[11.5px] text-faint">{parts.join(" ")}</p>;
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

const Step = memo(function Step({ step, streaming, isAnswer, showFiles, excludedCalls, excludedChoices, capabilityCallId, quoteOrigin }: { quoteOrigin?: QuoteOrigin; step: StepView; streaming: boolean; isAnswer: boolean; showFiles: boolean; excludedCalls: ReadonlySet<string>; excludedChoices: ReadonlySet<string>; capabilityCallId?: string }) {
  useStore(s => s.locale);
  const thinking = streaming && step.thought !== "" && step.text === "" && step.calls.length === 0;
  return (
    <div className="space-y-2">
      {step.thought !== "" && <Thought text={step.thought} active={thinking} />}
      {step.replaced && step.text.trim() !== "" ? (
        <Draft text={step.text} />
      ) : step.text.trim() !== "" &&
        (isAnswer || (streaming && step.calls.length === 0) ? (
          quoteOrigin ? <SelectionFollowup source={quoteOrigin}><Markdown text={step.text} {...(step.unverifiedLinks && { unverified: step.unverifiedLinks })} /></SelectionFollowup> : <Markdown text={step.text} {...(step.unverifiedLinks && { unverified: step.unverifiedLinks })} />
        ) : (
          <p className="selectable whitespace-pre-wrap text-[13.5px] text-muted">{step.text.trim()}</p>
        ))}
      {step.calls.filter(c => !excludedCalls.has(c.callId) && (c.tool !== "task_update" || c.status === "awaiting" || c.handoff)).map((c) => (
        <CallCard key={c.callId} call={c} readOnly showFiles={showFiles} showCapabilities={c.callId === capabilityCallId} />
      ))}
      {step.choices.filter(choice => !excludedChoices.has(choice.callId)).map((choice) => <ChoiceCard key={choice.callId} choice={choice} readOnly />)}
    </div>
  );
});

/** What the model wrote before the cards that now show it: kept, out of the way. */
function Draft({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[12.5px] text-faint transition-colors hover:text-muted"
        aria-expanded={open}
      >
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        <span>{t("choice.draft")}</span>
      </button>
      {open && (
        <div className="selectable mt-1.5 ml-[5px] max-h-72 overflow-auto whitespace-pre-wrap border-l border-line pl-3.5 text-[12.5px] leading-relaxed text-faint scroll-thin">
          {draftText(text)}
        </div>
      )}
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
  return step !== undefined && step.text.trim() !== "" && step.calls.length === 0 && step.choices.length === 0;
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
    <details className="group text-[11.5px] text-muted">
      <summary className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-ember">{t("turn.details")}</summary>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Mochi size={12} face={false} className="text-ember/70" />
      <span className="font-medium text-muted">{shortModelName(run.model)}</span>
      <span>·</span>
      <span className="tabular-nums">{parts.join(" · ")}</span>
      </div>
    </details>
  );
}

function isEmpty(s: StepView): boolean {
  return s.thought === "" && s.text === "" && s.calls.length === 0 && s.choices.length === 0;
}

function AnswerActions({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "error">("idle");
  useEffect(() => setState("idle"), [text]);
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" disabled={state === "busy"} className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50" onClick={() => {
      setState("busy");
      void Promise.resolve().then(() => copyAnswer(text, navigator.clipboard)).then(() => setState("copied"), () => setState("error"));
    }}>{t(state === "copied" ? "turn.copied" : "turn.copy")}</button>
    {state === "error" && <span role="alert" className="text-[12px] text-danger">{t("turn.copyFailed")}</span>}
  </div>;
}
