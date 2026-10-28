import { t } from '@vunemi/i18n';
import { isTrackingTool, type TaskRecord } from './tasks.js';

/** A file delivery can close from receipts; factual research answers still need the model. */
export function completedDelivery(task: TaskRecord | undefined, readBack: ReadonlySet<string>): string | null {
 if (!task || task.status !== 'running' || task.paused || task.waitingPlan || !task.steps.length ||
     task.steps.some(s => s.status !== 'completed' || s.evidence !== 'tool_result') ||
     task.operations.some(o => ['unknown','running','waiting_user','waiting_approval','proposed','approved'].includes(o.status))) return null;
 const work=task.operations.filter(o => o.status === 'completed' && !isTrackingTool(o.tool));
 if (!work.some(o => o.actionClass === 'write-local') || work.some(o => !['read','write-local'].includes(o.actionClass)) ||
     !task.outputs.length || task.outputs.some(o => o.kind !== 'file')) return null;
 const files=[...new Set(task.outputs.flatMap(o => o.kind === 'file' ? [o.path] : []))];
 const verified=files.every(path => readBack.has(path));
 return t(verified ? (files.length === 1 ? 'agent.deliveryVerifiedOne' : 'agent.deliveryVerifiedMany') :
   (files.length === 1 ? 'agent.deliverySavedOne' : 'agent.deliverySavedMany'), { count: files.length });
}
