/** Observation-only utility protocol. Mutations and permission prompts never cross it. */
export type NativeObservationOp='apps'|'windows'|'background_environment'|'permissions';
export const NATIVE_OBSERVATION_OWNER='observation-only';
export interface NativeObservationInit {kind:'init';epoch:string;helperPath:string;locale:string}
export interface NativeObservationReady {kind:'ready';epoch:string}
export interface NativeObservationInvoke {kind:'invoke';epoch:string;id:number;owner:string;op:NativeObservationOp;args:Record<string,unknown>;timeoutMs:number}
export interface NativeObservationCancel {kind:'cancel';epoch:string;id:number;owner:string}
export interface NativeObservationReply {kind:'reply';epoch:string;id:number;owner:string;ok:boolean;value?:unknown;error?:string;nativeRejection?:boolean}
export type NativeObservationHostMessage=NativeObservationInit|NativeObservationInvoke|NativeObservationCancel;
export type NativeObservationWorkerMessage=NativeObservationReady|NativeObservationReply;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)&&Reflect.ownKeys(v).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>'value'in d);
/** Runtime allowlist. Describe stays local: native snapshots belong to its helper process. */
export function isNativeObservationRequest(op:unknown,args:unknown):op is NativeObservationOp{
 if(!record(args))return false;
 if(op==='apps'||op==='background_environment')return Object.keys(args).length===0;
 if(op==='permissions')return Object.keys(args).length===1&&args.prompt===false;
 return op==='windows'&&Object.keys(args).sort().join(',')==='app,background'&&args.background===true&&typeof args.app==='string'&&!!args.app.trim()&&args.app.length<=256&&!/[\u0000-\u001f]/u.test(args.app);
}
