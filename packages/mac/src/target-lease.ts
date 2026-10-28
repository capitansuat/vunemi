import {admissionErrorText} from './admission-errors.js';
/** Application-level ownership. Native foreground/snapshot checks still decide delivery. */
export interface LeaseTarget {bundleId:string;pid:number;processStartedAt:number;windowId:number}
export class NoInputSent extends Error {
 readonly noInputSent=true;readonly deliveryUnknown=false;
 constructor(message:string,readonly reasonCode:string){super(admissionErrorText(reasonCode,message));this.name='NoInputSent';}
}
export function validOwner(owner:unknown):owner is string{return typeof owner==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(owner);}
export function validLeaseTarget(target:unknown):target is LeaseTarget {
 if(!target||typeof target!=='object'||Array.isArray(target))return false;
 const t=target as LeaseTarget;
 return Object.keys(t).every(k=>['bundleId','pid','processStartedAt','windowId'].includes(k))&&typeof t.bundleId==='string'&&/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(t.bundleId)&&Number.isSafeInteger(t.pid)&&t.pid>0&&Number.isFinite(t.processStartedAt)&&t.processStartedAt>0&&Number.isSafeInteger(t.windowId)&&t.windowId>0;
}
const key=(t:LeaseTarget)=>JSON.stringify([t.bundleId,t.pid,t.processStartedAt,t.windowId]);
export class TargetLeases {
 private readonly targets=new Map<string,{owner:string;unknown:boolean}>();
 private readonly owners=new Map<string,'open'|'closed'>();
 private unknownGlobal=false;
 private owner(owner:string):void {
  if(!validOwner(owner))throw new NoInputSent('A valid run owner identity is required.','invalid-owner');
  if(this.owners.get(owner)==='closed')throw new NoInputSent('Run owner is closed; no new dispatch is allowed.','owner-closed');
  if(!this.owners.has(owner)){if(this.owners.size>=4096)throw new NoInputSent('Owner admission capacity reached; restart after resolving pending work.','lease-capacity');this.owners.set(owner,'open');}
  if(this.unknownGlobal)throw new NoInputSent('Prior delivery is uncertain without a target identity; inspect before recovery.','delivery-blocked');
 }
 assertOwner(owner:string):void {this.owner(owner);}
 acquire(owner:string,target:LeaseTarget):void {
  this.owner(owner);if(!validLeaseTarget(target))throw new NoInputSent('Exact target identity is required.','invalid-target');
  // Persisted legacy launch dates and public process start microseconds may differ.
  // An unresolved delivery keeps the same process/window blocked across subsecond launch-time representations.
  for(const [heldId,held] of this.targets){if(!held.unknown)continue;const [bundle,pid,start,windowId]=JSON.parse(heldId) as [string,number,number,number];if(bundle===target.bundleId&&pid===target.pid&&windowId===target.windowId&&Math.abs(start-target.processStartedAt)<1)throw new NoInputSent('Prior target delivery is uncertain; no retry is authorised.','delivery-blocked');}
  const id=key(target),prior=this.targets.get(id);
  if(prior?.unknown)throw new NoInputSent('Prior target delivery is uncertain; no retry is authorised.','delivery-blocked');
  if(prior&&prior.owner!==owner)throw new NoInputSent('Target is busy in another run.','target-busy');
  if(!prior&&this.targets.size>=512)throw new NoInputSent('Target lease capacity reached.','lease-capacity');
  this.targets.set(id,{owner,unknown:false});
 }
 admitOpen(owner:string,isolated:readonly LeaseTarget[]=[]):void {
  this.owner(owner);
  const proven=new Set(isolated.filter(validLeaseTarget).map(key));
  for(const [id,held] of this.targets)if(held.unknown?!proven.has(id):held.owner!==owner)throw new NoInputSent(held.unknown?'Prior delivery is uncertain; document opening is blocked.':'Another run owns a target; document opening is busy.',held.unknown?'delivery-blocked':'target-busy');
 }
 markUnknown(owner:string,target?:LeaseTarget):void {this.restoreUnknown(owner,target);}
 restoreUnknown(owner:string,target?:LeaseTarget):void {
  if(!validOwner(owner)||target!==undefined&&!validLeaseTarget(target))throw Error('Invalid restored lease identity.');
  if(!target){this.unknownGlobal=true;return;}
  if(this.targets.size>=512&&!this.targets.has(key(target)))throw Error('Unknown target lease capacity reached.');
  this.targets.set(key(target),{owner,unknown:true});
 }
 closeOwner(owner:string):void {if(!validOwner(owner))throw new NoInputSent('Invalid run owner.','invalid-owner');if(!this.owners.has(owner)&&this.owners.size>=4096)throw new NoInputSent('Owner admission capacity reached.','lease-capacity');this.owners.set(owner,'closed');}
 releaseKnown(owner:string):void {for(const [id,held]of this.targets)if(held.owner===owner&&!held.unknown)this.targets.delete(id);}
}
