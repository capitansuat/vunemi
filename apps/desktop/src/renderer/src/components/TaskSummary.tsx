import { NativeRecipePermissions } from "./NativeRecipePermissions.js";
import { TaskPermissions } from "./TaskPermissions.js";
import { outputState } from "../lib/output-state.js";
import { RecoveryActions } from "./RecoveryActions.js";
import { memo, useState } from "react";
import { CalendarDays, Check, ChevronRight, Circle, FileText, FolderOpen, LoaderCircle, Mail, Package, TriangleAlert } from "lucide-react";
import type { TaskRecord, TaskStep } from "@vunemi/agent-core";
import type { ArtefactView } from "../../../shared/ipc.js";
import { t } from "@vunemi/i18n";
import { outputArtefact, outputTitle, taskSummary } from "../lib/task-summary.js";
import { useStore } from "../store.js";
import {attentionTaskAnchor} from '../lib/task-attention.js';

/** Task progress and evidence; pending decisions appear at the end of the turn. */
export const TaskSummary = memo(function TaskSummary({ task, artefacts, recovery = false,anchor=true }: { task: TaskRecord; artefacts?: ArtefactView[]; recovery?: boolean;anchor?:boolean }) {
  useStore(s => s.locale);
  const known = useStore(s => s.artefacts);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const summary = taskSummary(task);
  const hasPermissions=useStore(s=>s.taskPermissions?.grants.some(g=>g.taskId===task.id));
  const hasNativeRecipe=useStore(s=>s.nativeRecipes?.recipes.some(r=>r.slots.some(slot=>slot.runId!==undefined&&task.runIds.includes(slot.runId))));
  if (!summary.show&&!hasPermissions&&!hasNativeRecipe) return anchor?<div id={attentionTaskAnchor(task.id)} data-task-id={task.id} tabIndex={-1} aria-label={task.goal} />:null;
  const rows = artefacts ?? known;
  const desktop = [...task.operations].reverse().find(o => o.desktopEvidence);
  const live = ["running", "waiting_approval", "waiting_user", "paused"].includes(task.status);
  const warn = summary.uncertain > 0 || ["needs_review", "failed", "interrupted"].includes(task.status);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)); }
    finally { setBusy(null); }
  };
  return (
    <div id={anchor?attentionTaskAnchor(task.id):undefined} data-task-id={anchor?task.id:undefined} tabIndex={anchor?-1:undefined} aria-label={task.goal} className="overflow-hidden rounded-xl border border-line bg-surface/80 outline-none focus-visible:ring-2 focus-visible:ring-ember">
      <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        {warn ? <TriangleAlert size={14} className="shrink-0 text-warn" aria-hidden="true" /> : task.status === "completed" ? <Check size={14} className="shrink-0 text-ok" aria-hidden="true" /> : <span className={`size-1.5 shrink-0 rounded-full ${live ? "bg-ember" : "bg-faint"}`} />}
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-fg">{t(`chatTask.status.${task.status}`)}</span>
        <span className="text-[11.5px] tabular-nums text-muted">{t("chatTask.progress", { done: summary.completed, total: task.steps.length })}</span>
      </div>
      <TaskPermissions taskId={task.id} compact />
      <NativeRecipePermissions runIds={task.runIds} />
      {desktop?.desktopEvidence && <p className="selectable border-t border-line px-3.5 py-2 text-[12px] text-muted">{t("chatTask.target")} · {desktop.desktopEvidence.bundleId} · {desktop.desktopEvidence.windowTitle}{desktop.tool.startsWith("desktop_background_") && <> · {t("chatTask.mode.background")}</>}</p>}
      {recovery && <RecoveryActions />}
      {task.runIds.length > 1 && <p className="selectable border-t border-line px-3.5 py-2 text-[12px] text-muted"><span className="text-faint">{t("chatTask.resumed")} · </span>{task.goal}</p>}
      {(summary.uncertain > 0 || task.status === "needs_review") && <p className="border-t border-line px-3.5 py-2 text-[12px] leading-relaxed text-muted">{t(summary.uncertain ? "chatTask.uncertain" : "chatTask.review")}</p>}
      {summary.remaining.length > 0 && <div className="border-t border-line px-3.5 py-2.5">
        <p className="mb-1.5 text-[11px] font-medium text-faint">{t("chatTask.remaining")}</p>
        <ol className="space-y-1.5">{summary.remaining.slice(0, 2).map((step, i) => <StepRow key={`${i}:${step.title}`} step={step} running={task.status === "running"} />)}</ol>
      </div>}
      <details className="group border-t border-line px-3.5 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-[11.5px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ember"><ChevronRight size={12} aria-hidden="true" className="group-open:rotate-90" />{t("chatTask.steps")}</summary>
        <ol className="mt-2.5 space-y-2 pb-1">{task.steps.map((step, i) => <StepRow key={i} step={step} running={task.status === "running"} />)}</ol>
      </details>
      {task.outputs.length > 0 && <div className="border-t border-line px-3.5 py-2.5">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-faint"><Package size={12} aria-hidden="true" />{t("chatTask.outputs")}</p>
        <ul className="space-y-2">{task.outputs.slice(0, 3).map((item, i) => {
          const row = outputArtefact(item, rows);
          const Icon = item.kind === "draft" ? Mail : item.kind === "event" || item.kind === "reminder" ? CalendarDays : FileText;
          return <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <Icon size={13} aria-hidden="true" className="shrink-0 text-faint" /><span className="min-w-0 flex-1 break-words text-fg">{outputTitle(item)}</span>
            <span className="text-[11.5px] text-muted">{t(`outputState.${outputState(item, [task])}`)}</span>
            {row?.missing && <span className="text-[11px] text-muted">{t("chatTask.missing")}</span>}
            {row && !row.missing && (row.canOpen || row.canPreview) && <button type="button" disabled={busy !== null} onClick={() => void act(row.id, () => row.canPreview ? useStore.getState().showPreview(row.id) : window.vunemi.openArtefact(row.id))} className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50">{t(row.canPreview ? "artefacts.preview" : "common.open")}</button>}
            {row?.canReveal && !row.missing && <button type="button" aria-label={`${t("artefacts.reveal")}: ${outputTitle(item)}`} disabled={busy !== null} onClick={() => void act(row.id, () => window.vunemi.revealArtefact(row.id))} className="rounded-md p-1.5 text-muted hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50"><FolderOpen size={13} aria-hidden="true" /></button>}
          </li>;
        })}</ul>
        {task.outputs.length > 3 && <button type="button" onClick={() => useStore.getState().setView("artefacts")} className="mt-2 rounded text-[11.5px] text-muted underline focus-visible:ring-2 focus-visible:ring-ember">{t("chatTask.allOutputs")}</button>}
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>}
    </div>
  );
});

function StepRow({ step, running }: { step: TaskStep; running: boolean }) {
  const supported = step.status === "completed" && step.evidence === "tool_result";
  const reported = step.status === "completed" && !supported;
  const working = step.status === "working" && running;
  const Icon = supported ? Check : reported ? TriangleAlert : working ? LoaderCircle : Circle;
  const label = t(supported ? "chatTask.supported" : reported ? "chatTask.reported" : working ? "chatTask.status.running" : "chatTask.pending");
  return <li className="flex items-start gap-2 text-[12px] leading-relaxed">
    <Icon size={13} aria-label={label} className={`mt-0.5 shrink-0 ${supported ? "text-ok" : reported ? "text-warn" : "text-faint"} ${working ? "motion-safe:animate-spin" : ""}`} />
    <span className="selectable min-w-0 break-words text-muted">{step.title}{reported && <span className="ml-1.5 text-[11px] text-faint">· {t("chatTask.reported")}</span>}</span>
  </li>;
}
