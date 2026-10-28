import type {ScopedApprovalRequest} from '../shared/ipc.js';
import type {TaskPermissionRevokeRequest} from '@vunemi/agent-core';
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Invalid task permission request.');
 const out=value as Record<string,unknown>,actual=Object.keys(out);
 if(actual.length!==keys.length||actual.some(key=>!keys.includes(key)))throw Error('Invalid task permission request fields.');return out;
}
function id(value:unknown):string{if(typeof value!=='string'||!/^[-\w.:]{1,160}$/.test(value))throw Error('Invalid task permission identity.');return value}
function revision(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw Error('Invalid task permission revision.');return value}
export function scopedApprovalRequest(value:unknown):ScopedApprovalRequest{
 const x=record(value,['sessionId','runId','callId','decision']),d=record(x.decision,['kind','offerId','offerRevision']);
 if(d.kind!=='approve_run')throw Error('Invalid task permission decision.');
 return {sessionId:id(x.sessionId),runId:id(x.runId),callId:id(x.callId),decision:{kind:'approve_run',offerId:id(d.offerId),offerRevision:revision(d.offerRevision)}};
}
export function permissionListRequest(value:unknown):{sessionId:string;runId:string|null}{const x=record(value,['sessionId','runId']);return {sessionId:id(x.sessionId),runId:x.runId===null?null:id(x.runId)}}
export function permissionRevokeRequest(value:unknown):TaskPermissionRevokeRequest{const x=record(value,['grantId','sessionId','runId','expectedRevision']);return {grantId:id(x.grantId),sessionId:id(x.sessionId),runId:id(x.runId),expectedRevision:revision(x.expectedRevision)}}
