import { isTrackingTool, type TaskRecord, type TaskStep, type Produced } from "@vunemi/agent-core";
import type { ArtefactView } from "../../../shared/ipc.js";

export function taskSummary(task: TaskRecord): { show: boolean; completed: number; remaining: TaskStep[]; uncertain: number } {
  const supported = (step: TaskStep) => step.status === "completed" && step.evidence === "tool_result";
  return {
    show: !task.waitingPlan && (task.planAccepted || task.outputs.length > 0 || task.operations.some(o => !isTrackingTool(o.tool))),
    completed: task.steps.filter(supported).length,
    remaining: task.steps.filter(s => !supported(s)),
    uncertain: task.operations.filter(o => o.status === "unknown").length,
  };
}

export function nearBottom(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < 80;
}

/** Use the registered artefact ID and its capabilities; never send the renderer's path to main. */
export function outputArtefact(item: Produced, rows: readonly ArtefactView[]): ArtefactView | undefined {
  const identity = (value: Produced) => JSON.stringify(value, Object.keys(value).sort());
  return rows.find(row => identity(row.item) === identity(item));
}

export function outputTitle(item: Produced): string {
  switch (item.kind) {
    case "file": case "download": return item.path.split(/[\\/]/).at(-1) || item.path;
    case "draft": return item.subject;
    default: return item.title;
  }
}
