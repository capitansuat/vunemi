import type {TaskRecord} from '@vunemi/agent-core';
import type {AttentionItem} from '../shared/ipc.js';
const title=(s:string)=>s.replace(/\s+/g,' ').trim().slice(0,120);
/** Narrow display projection. Never carries operation arguments, receipts or decision owners. */
export function taskAttention(session:{id:string;title:string;projectId?:string;recoveredRunId?:string},tasks:readonly TaskRecord[]):AttentionItem[]{
 return tasks.flatMap(task=>{
  let reason:AttentionItem['reason']|undefined;
  if(task.operations.some(op=>op.status==='unknown'))reason='uncertain';
  else if(task.status==='interrupted')reason='uncertain';
  else if(task.status==='needs_review')reason='review';
  else if(task.status==='waiting_approval')reason=task.waitingPlan?'plan':'approval';
  else if(task.status==='waiting_user')reason='user';
  else if(task.status==='stopped'&&task.activeRunId===session.recoveredRunId)reason='recovery';
  if(!reason)return [];
  return [{sessionId:session.id,taskId:task.id,runId:task.activeRunId,status:task.status,reason,title:title(task.goal),sessionTitle:title(session.title),updatedAt:task.updatedAt,...(session.projectId?{projectId:session.projectId}:{})}];
 });
}
