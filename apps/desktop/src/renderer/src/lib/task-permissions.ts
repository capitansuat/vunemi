import type { TaskPermissionOfferView, TaskPermissionsSnapshot } from '@vunemi/agent-core';
import { activeTurnAction, type CallView, type RunView } from './fold.js';
type OwnerState={running:boolean;paused?:boolean;taskApprovalStopped?:boolean;sessions:{current:string};activeRun:{sessionId:string;runId:string}|null;runs:RunView[]};
export function currentPermissionOffer(state:OwnerState,call:CallView):TaskPermissionOfferView|undefined {
 const offer=call.taskPermissionOffer,owner=state.activeRun;
 if(!offer||!owner||state.paused||state.taskApprovalStopped||!state.running||state.sessions.current!==owner.sessionId||offer.sessionId!==owner.sessionId||offer.runId!==owner.runId||offer.callId!==call.callId||call.status!=='awaiting'||call.alert||call.alwaysAsk||call.switchedOff||call.actionClass!=='read')return;
 if(!(call.tool==='files_read'&&offer.effect==='file-read'&&offer.target.kind==='file'||call.tool==='desktop_background_describe'&&offer.effect==='window-observe'&&offer.target.kind==='native-window'))return;
 const run=state.runs.find(r=>r.runId===owner.runId),action=run&&activeTurnAction(run,true);
 const latest=action?.kind==='approval'?action.call:undefined;
 if(latest?.taskPermissionOffer===offer&&latest.taskPermissionOffer?.offerId===offer.offerId&&latest.taskPermissionOffer.revision===offer.revision&&!latest.alert&&!latest.alwaysAsk&&!latest.switchedOff)return offer;
}
export function acceptsPermissionSnapshot(state:Pick<OwnerState,'sessions'|'activeRun'>,next:TaskPermissionsSnapshot,current:TaskPermissionsSnapshot|null):boolean {
 return next.sessionId===state.sessions.current&&next.runId===(state.activeRun?.runId??null)&&(!current||current.sessionId!==next.sessionId||next.revision>=current.revision);
}
export function permissionTarget(target:TaskPermissionOfferView['target']):string {
 return target.kind==='file'?target.path:`${target.appName} · PID ${target.pid} · ${target.windowTitle} #${target.windowId}`;
}
