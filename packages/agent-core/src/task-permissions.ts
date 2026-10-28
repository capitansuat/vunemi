export type TaskPermissionSubjectView =
 | {effect:'file-read';target:{kind:'file';path:string;name:string}}
 | {effect:'window-observe';target:{kind:'native-window';appName:string;bundleId:string;pid:number;windowId:number;windowTitle:string}};
export type TaskPermissionOwner={sessionId:string;taskId:string;runId:string};
export type TaskPermissionDescriptor =
 | (Extract<TaskPermissionSubjectView,{effect:'file-read'}> & {identity:{kind:'file';path:string;device:string;inode:string;size:string;mtimeNs:string;ctimeNs:string}})
 | (Extract<TaskPermissionSubjectView,{effect:'window-observe'}> & {identity:{kind:'native-window';bundleId:string;pid:number;startSec:string;startUsec:string;windowId:number;controlMode:'backgroundStrict'}});
export type TaskPermissionOfferView=TaskPermissionSubjectView & TaskPermissionOwner & {offerId:string;revision:number;callId:string;maxUses:8};
export type TaskPermissionView=TaskPermissionSubjectView & TaskPermissionOwner & {grantId:string;maxUses:8;remainingUses:number;issuedAt:number;status:'active'|'revoked'|'expired'|'exhausted';endedReason?:'run-ended'|'stopped'|'session-changed'|'target-changed'|'policy-changed'|'connector-changed'|'revoked'|'budget-exhausted'};
export type TaskPermissionsSnapshot={revision:number;sessionId:string;runId:string|null;grants:readonly TaskPermissionView[]};
export type TaskPermissionRevokeRequest={grantId:string;sessionId:string;runId:string;expectedRevision:number};
export type TaskPermissionEpoch={registration:number;policy:number;task:number};
export interface TaskPermissionTicket {readonly grantId:string;readonly generation:number;readonly runId:string}
type RecordScope={owner:TaskPermissionOwner;tool:string;descriptor:TaskPermissionDescriptor;epoch:TaskPermissionEpoch};
type Grant=RecordScope & {view:TaskPermissionView;generation:number};
const copy=<T>(value:T):T=>structuredClone(value);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sameOwner=(a:TaskPermissionOwner|undefined,b:TaskPermissionOwner|undefined)=>!!a&&!!b&&a.sessionId===b.sessionId&&a.taskId===b.taskId&&a.runId===b.runId;
const subject=(d:TaskPermissionDescriptor):TaskPermissionSubjectView=>({effect:d.effect,target:copy(d.target)} as TaskPermissionSubjectView);
function validate(tool:string,d:TaskPermissionDescriptor):void {
 const i=d?.identity,t=d?.target;
 const keys=(value:unknown,expected:string[])=>!!value&&typeof value==='object'&&Object.keys(value).sort().join(',')===expected.sort().join(',');
 if(!keys(d,['effect','target','identity']))throw new Error('Invalid task permission descriptor.');
 if(d.effect==='file-read'&&(!keys(t,['kind','path','name'])||!keys(i,['kind','path','device','inode','size','mtimeNs','ctimeNs'])))throw new Error('Invalid file permission descriptor.');
 if(d.effect==='window-observe'&&(!keys(t,['kind','appName','bundleId','pid','windowId','windowTitle'])||!keys(i,['kind','bundleId','pid','startSec','startUsec','windowId','controlMode'])))throw new Error('Invalid native permission descriptor.');
 if(d?.effect==='file-read' && tool==='files_read' && t?.kind==='file' && i?.kind==='file' && t.path===i.path && t.path.startsWith('/') && typeof t.name==='string' && [i.device,i.inode,i.size,i.mtimeNs,i.ctimeNs].every(v=>typeof v==='string'&&/^\d+$/.test(v)))return;
 if(d?.effect==='window-observe' && tool==='desktop_background_describe' && t?.kind==='native-window' && i?.kind==='native-window' && i.controlMode==='backgroundStrict' && t.bundleId===i.bundleId && t.pid===i.pid && t.windowId===i.windowId && Number.isSafeInteger(i.pid)&&i.pid>0&&Number.isSafeInteger(i.windowId)&&i.windowId>0 && [i.startSec,i.startUsec].every(v=>typeof v==='string'&&/^\d+$/.test(v)) && [t.appName,t.bundleId,t.windowTitle].every(v=>typeof v==='string'&&v.length<8192))return;
 throw new Error('Invalid task permission descriptor.');
}
export class TaskPermissionStore {
 private owner:TaskPermissionOwner|undefined;
 private revision=0;
 private serial=0;
 private offers=new Map<string,RecordScope & {view:TaskPermissionOfferView}>();
 private grants=new Map<string,Grant>();
 private runGeneration=0;
 private tickets=new WeakMap<TaskPermissionTicket,{grant:Grant;runGeneration:number}>();
 constructor(private onChanged?:(snapshot:TaskPermissionsSnapshot)=>void){}
 private changed(){this.revision++;this.onChanged?.(this.snapshot());}
 private owned(owner:TaskPermissionOwner){if(!sameOwner(this.owner,owner))throw new Error('Task permission owner changed.');}
 bind(owner:TaskPermissionOwner):void{if(sameOwner(this.owner,owner))return;this.expire('run-ended');this.owner=copy(owner);this.offers.clear();this.changed();}
 offer(callId:string,tool:string,descriptor:TaskPermissionDescriptor,epoch:TaskPermissionEpoch):TaskPermissionOfferView{
 if(!this.owner)throw new Error('No active run.');validate(tool,descriptor);
 if(this.offers.size>=128)throw new Error('Too many permission offers.');
 const view={...subject(descriptor),...this.owner,offerId:`offer-${++this.serial}`,revision:this.revision+1,callId,maxUses:8 as const};
 this.offers.set(view.offerId,{owner:copy(this.owner),tool,descriptor:copy(descriptor),epoch:copy(epoch),view});this.changed();return copy(view);
 }
 canApprove(offerId:string,offerRevision:number,owner:TaskPermissionOwner,callId:string):boolean{
 const o=this.offers.get(offerId);return sameOwner(this.owner,owner)&&!!o&&o.view.revision===offerRevision&&o.view.callId===callId&&sameOwner(o.owner,owner);
 }
 approve(offerId:string,offerRevision:number,owner:TaskPermissionOwner,callId:string):string{
 this.owned(owner);if(!this.canApprove(offerId,offerRevision,owner,callId))throw new Error('Stale or foreign permission offer.');const o=this.offers.get(offerId)!;
 if(this.grants.size>=128){for(const [id,g]of this.grants)if(g.view.status!=='active')this.grants.delete(id);if(this.grants.size>=128)throw new Error('Too many active permissions.');}
 this.offers.delete(offerId);const id=`grant-${++this.serial}`;const view={...subject(o.descriptor),...owner,grantId:id,maxUses:8 as const,remainingUses:8,issuedAt:Date.now(),status:'active' as const};this.grants.set(id,{...o,view,generation:0});this.changed();return id;
 }
 match(owner:TaskPermissionOwner,tool:string,descriptor:TaskPermissionDescriptor,epoch:TaskPermissionEpoch):string|undefined{validate(tool,descriptor);if(!sameOwner(this.owner,owner))return;for(const [id,g]of this.grants)if(g.view.status==='active'&&sameOwner(g.owner,owner)&&g.tool===tool&&equal(g.descriptor.identity,descriptor.identity)&&equal(g.epoch,epoch))return id;}
 reserve(id:string,owner:TaskPermissionOwner,tool:string,descriptor:TaskPermissionDescriptor,epoch:TaskPermissionEpoch):TaskPermissionTicket{
 this.owned(owner);if(this.match(owner,tool,descriptor,epoch)!==id)throw new Error('Task permission unavailable.');const g=this.grants.get(id)!;g.view.remainingUses--;if(!g.view.remainingUses){g.view.status='exhausted';g.view.endedReason='budget-exhausted';}const ticket=Object.freeze({grantId:id,generation:g.generation,runId:owner.runId});this.tickets.set(ticket,{grant:g,runGeneration:this.runGeneration});this.changed();return ticket;
 }
 assert(ticket:TaskPermissionTicket):void{const entry=this.tickets.get(ticket),g=entry?.grant;if(!g||entry?.runGeneration!==this.runGeneration||g.generation!==ticket.generation||!sameOwner(this.owner,g.owner))throw new Error('Task permission revoked or expired.');}
 finish(ticket:TaskPermissionTicket):void{this.tickets.delete(ticket);}
 revoke(request:TaskPermissionRevokeRequest):TaskPermissionsSnapshot{const g=this.grants.get(request.grantId);if(!g||request.expectedRevision!==this.revision||request.sessionId!==this.owner?.sessionId||request.runId!==this.owner?.runId||g.owner.runId!==request.runId)throw new Error('Stale or foreign permission revoke.');g.generation++;g.view.status='revoked';g.view.endedReason='revoked';this.offers.clear();this.changed();return this.snapshot();}
 expire(reason:NonNullable<TaskPermissionView['endedReason']>):void{this.runGeneration++;this.offers.clear();let changed=false;for(const g of this.grants.values()){g.generation++;if(g.view.status==='active'||g.view.status==='exhausted'){g.view.status='expired';g.view.endedReason=reason;changed=true;}}if(changed)this.changed();}
 snapshot():TaskPermissionsSnapshot{return copy({revision:this.revision,sessionId:this.owner?.sessionId??'',runId:this.owner?.runId??null,grants:[...this.grants.values()].filter(g=>g.owner.sessionId===this.owner?.sessionId&&g.owner.runId===this.owner?.runId).map(g=>g.view)});}
}
