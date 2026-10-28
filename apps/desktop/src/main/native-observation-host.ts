import {randomUUID} from 'node:crypto';
import {isNativeObservationRequest,NATIVE_OBSERVATION_OWNER,type NativeObservationInvoke} from '../shared/native-observation.js';
export interface NativeObservationChild {postMessage(message:unknown):void;on(event:'message',listener:(message:unknown)=>void):unknown;on(event:'exit',listener:(code:number)=>void):unknown;kill():boolean}
interface Options {spawn:()=>NativeObservationChild;helperPath:string;locale:()=>string;startTimeoutMs?:number;cancelTimeoutMs?:number}
interface CallOptions {signal?:AbortSignal;assertActive?:()=>void;timeoutMs?:number;ownerRunId?:string}
interface Pending {id:number;owner:string;op:NativeObservationInvoke['op'];args:Record<string,unknown>;timeoutMs:number;resolve:(value:unknown)=>void;reject:(error:Error)=>void;opts:CallOptions;sent:boolean;cancelled?:Error;timer?:ReturnType<typeof setTimeout>;validity?:ReturnType<typeof setInterval>;abort:()=>void}
const error=(message:string)=>Object.assign(new Error(message),{noInputSent:true});
/** Separate read-only worker. An explicit next call may restart; a crashed request never replays. */
export class NativeObservationHost {
 private child:NativeObservationChild|null=null;
 private epoch='';private ready=false;private disposed=false;private nextId=1;private pending:Pending|null=null;
 constructor(private readonly options:Options){}
 call(op:string,args:Record<string,unknown>={},opts:CallOptions={}):Promise<unknown>{
  if(this.disposed)return Promise.reject(error('Observation host disposed.'));
  if(this.pending)return Promise.reject(error('Observation host busy.'));
  if(!isNativeObservationRequest(op,args))return Promise.reject(error('Unsupported observation request.'));
  const owner=opts.ownerRunId??NATIVE_OBSERVATION_OWNER,timeoutMs=opts.timeoutMs??30000;
  if(typeof owner!=='string'||!owner||owner.length>256||/[\u0000-\u001f]/u.test(owner)||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>150000)return Promise.reject(error('Invalid observation owner or deadline.'));
  try{if(opts.signal?.aborted)throw error('Observation stopped.');opts.assertActive?.();}catch(e){return Promise.reject(e);}
  const copied=structuredClone(args);
  return new Promise((resolve,reject)=>{
   const pending:Pending={id:this.nextId++,owner,op,args:copied,timeoutMs,resolve,reject,opts,sent:false,abort:()=>this.cancel(error('Observation stopped.'))};this.pending=pending;
   opts.signal?.addEventListener('abort',pending.abort,{once:true});
   if(opts.assertActive)pending.validity=setInterval(()=>{try{opts.assertActive!();}catch(e){this.cancel(e instanceof Error?e:error('Inactive observation owner.'));}},25);
   try{if(!this.child)this.start();if(this.ready)this.invoke();else pending.timer=setTimeout(()=>{if(this.pending===pending){pending.cancelled=error('Observation worker startup timeout.');this.child?.kill();}},this.options.startTimeoutMs??5000);}catch(e){const failure=e instanceof Error?e:error('Observation worker unavailable.');if(this.child)this.cancel(failure);else this.finish(undefined,failure);}
   if(opts.signal?.aborted)pending.abort();
  });
 }
 private start(){
  const epoch=randomUUID(),child=this.options.spawn();this.child=child;this.epoch=epoch;this.ready=false;
  child.on('message',message=>{if(this.child!==child||this.epoch!==epoch||!message||typeof message!=='object'||Array.isArray(message))return;const m=message as Record<string,unknown>;
   if(m.epoch!==epoch)return;
   if(m.kind==='ready'&&Object.keys(m).sort().join(',')==='epoch,kind'){if(this.ready)return;this.ready=true;if(!this.pending?.cancelled)this.invoke();return;}
   const p=this.pending;if(!p||!p.sent||m.kind!=='reply'||m.id!==p.id||m.owner!==p.owner||typeof m.ok!=='boolean'||Object.keys(m).some(k=>!['kind','epoch','id','owner','ok','value','error','nativeRejection'].includes(k))||m.error!==undefined&&typeof m.error!=='string'||m.nativeRejection!==undefined&&typeof m.nativeRejection!=='boolean')return;
   if(p.cancelled){this.finish(undefined,p.cancelled);return;}
   try{if(p.opts.signal?.aborted)throw error('Observation stopped.');p.opts.assertActive?.();}catch(e){this.finish(undefined,e instanceof Error?e:error('Inactive observation owner.'));return;}
   if(m.ok)this.finish(m.value);else this.finish(undefined,Object.assign(error(typeof m.error==='string'?m.error:'Observation failed.'),m.nativeRejection===true?{nativeRejection:true}:{}));
  });
  child.on('exit',code=>{if(this.child!==child||this.epoch!==epoch)return;this.child=null;this.ready=false;this.finish(undefined,this.pending?.cancelled??error(`Observation worker exited (${code}).`));});
  child.postMessage({kind:'init',epoch,helperPath:this.options.helperPath,locale:this.options.locale()});
 }
 private invoke(){const p=this.pending;if(!p||p.sent||p.cancelled||!this.child||!this.ready)return;
  try{if(p.opts.signal?.aborted)throw error('Observation stopped.');p.opts.assertActive?.();}catch(e){this.cancel(e instanceof Error?e:error('Inactive observation owner.'));return;}
  clearTimeout(p.timer);p.sent=true;p.timer=setTimeout(()=>this.cancel(error('Observation timeout.')),p.timeoutMs);
  try{this.child.postMessage({kind:'invoke',epoch:this.epoch,id:p.id,owner:p.owner,op:p.op,args:p.args,timeoutMs:p.timeoutMs} satisfies NativeObservationInvoke);}catch(e){this.cancel(e instanceof Error?e:error('Observation transport failed.'));}
 }
 private cancel(reason:Error){const p=this.pending;if(!p||p.cancelled)return;p.cancelled=reason;clearTimeout(p.timer);clearInterval(p.validity);
  if(!p.sent){this.child?.kill();return;}
  try{this.child?.postMessage({kind:'cancel',epoch:this.epoch,id:p.id,owner:p.owner});}catch{this.child?.kill();}
  p.timer=setTimeout(()=>{if(this.pending===p)this.child?.kill();},this.options.cancelTimeoutMs??1000);
 }
 private finish(value?:unknown,failure?:Error){const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timer);clearInterval(p.validity);p.opts.signal?.removeEventListener('abort',p.abort);failure?p.reject(failure):p.resolve(value);}
 dispose():void{if(this.disposed)return;this.disposed=true;if(this.pending)this.cancel(error('Observation host disposed.'));this.child?.kill();}
}
