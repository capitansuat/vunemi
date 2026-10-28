import type {AttentionSnapshot,AttentionTarget} from '../shared/ipc.js';
/** Selection is navigation only; stale archive entries cannot resolve or resume work. */
export function requireAttentionTarget(snapshot:AttentionSnapshot,raw:unknown):AttentionTarget{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid attention target.');
 const x=raw as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='revision,runId,sessionId,taskId'||!['sessionId','taskId','runId'].every(k=>typeof x[k]==='string'&&(x[k] as string).length>0&&(x[k] as string).length<=256)||!Number.isSafeInteger(x.revision)||x.revision!==snapshot.revision)throw Error('Attention list changed. Refresh and select the task again.');
 if(!snapshot.items.some(i=>i.sessionId===x.sessionId&&i.taskId===x.taskId&&i.runId===x.runId))throw Error('This task no longer needs attention.');
 return {sessionId:x.sessionId as string,taskId:x.taskId as string,runId:x.runId as string,revision:x.revision as number};
}
