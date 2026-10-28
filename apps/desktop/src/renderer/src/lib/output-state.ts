import { type Produced, type TaskRecord } from '@vunemi/agent-core';
export type OutputState = 'created'|'checked'|'savedChecked'|'draft'|'added'|'downloaded'|'uncertain';
/** Display only typed receipt evidence. Model prose and mere produced metadata
 * never establish content review, disk save or message delivery. */
export function outputState(item:Produced,tasks:readonly TaskRecord[]):OutputState {
  if(item.kind==='draft')return 'draft';
  if(item.kind==='event'||item.kind==='reminder')return 'added';
  if(item.kind==='download')return 'downloaded';
  const ordered=[...tasks].sort((a,b)=>b.updatedAt-a.updatedAt);
  for(const task of ordered){
    const relevant=task.operations.filter(o=>(o.fileEvidence?.path??o.filePath)===item.path||o.fileEvidence?.paths?.includes(item.path)||o.desktopEvidence?.documentPath===item.path||o.desktopEvidence?.requestedPath===item.path);
    for(const op of relevant.toReversed()){
      if(op.actionClass!=='read'&&['unknown','running','waiting_user'].includes(op.status))return 'uncertain';
      if(op.status!=='completed')continue;
      const e=op.desktopEvidence;
      if(e?.kind==='verified-save'&&e.version===1&&e.bundleId==='com.apple.TextEdit'&&e.processStartedAt>0&&e.windowId>0&&e.fieldRef>0&&!!e.windowTitle&&!!e.operationId&&/^[a-f0-9]{64}$/.test(e.valueHash)&&e.diskHash===e.valueHash)return 'savedChecked';
      if(op.fileEvidence?.kind==='verified-read'&&op.fileEvidence.review?.version===1&&op.fileEvidence.review.fingerprint)return 'checked';
      if(op.actionClass!=='read'||op.fileEvidence?.kind==='write')return 'created';
    }
  }
  return 'created';
}
