import {randomUUID} from 'node:crypto';
import {nativeErrorText,NativeProcessBroker,type NativeProcessBrokerEvent,type ExecutionTransport,type ObservationTransportOptions} from '@vunemi/mac';
import {nativeExecutionRecord,nativeExecutionOwner} from '../shared/native-execution.js';
export interface NativeExecutionChild {postMessage(message:unknown):void;on(event:'message',listener:(message:unknown)=>void):unknown;on(event:'exit',listener:(code:number)=>void):unknown;kill():boolean}
interface Broker {subscribe(listener:(event:NativeProcessBrokerEvent)=>void):()=>void;dispatch(id:number,op:string,args:Record<string,unknown>):string;complete(id:number):void;terminateAndWait():Promise<void>;dispose():void}
interface Options {spawn:()=>NativeExecutionChild;binary?:string;broker?:Broker;startTimeoutMs?:number;cancelTimeoutMs?:number}
interface Pending {id:number;owner:string;op:string;args:Record<string,unknown>;opts:ObservationTransportOptions;resolve:(value:unknown)=>void;reject:(error:Error)=>void;begun:boolean;dispatched:boolean;nativeEpoch?:string;cancelled?:Error;timer?:ReturnType<typeof setTimeout>;validity?:ReturnType<typeof setInterval>;abort:()=>void}
/** Main owns approved payload + actual native handle; the worker owns serialization and reply parsing. */
export class NativeExecutionHost implements ExecutionTransport {
 private readonly broker:Broker;private child:NativeExecutionChild|null=null;private epoch='';private ready=false;private disposed=false;private serial=0;private pending:Pending|null=null;private settling:Promise<void>|null=null;private readonly unsubscribe:()=>void;
 constructor(private readonly options:Options){this.broker=options.broker??new NativeProcessBroker(options.binary!);this.unsubscribe=this.broker.subscribe(event=>this.nativeEvent(event));}
 call(op:string,args:Record<string,unknown>={},opts:ObservationTransportOptions={}):Promise<unknown>{
  if(this.disposed)return Promise.reject(Error('Native execution host disposed.'));
  if(this.pending||this.settling)return Promise.reject(Object.assign(Error('Native execution host busy.'),{noInputSent:true}));
  const owner=opts.ownerRunId??'main-owned',timeout=opts.timeoutMs??20000;
  if(!nativeExecutionOwner(owner)||!/^[a-z][a-z0-9_]{0,95}$/.test(op)||!Number.isFinite(timeout)||timeout<1||timeout>300000||!nativeExecutionRecord(args))return Promise.reject(Object.assign(Error('Invalid native execution request.'),{noInputSent:true}));
  try{if(opts.signal?.aborted)throw Error('Native execution stopped.');opts.assertActive?.();}catch(error){return Promise.reject(error);}
  let snapshot:Record<string,unknown>;try{snapshot=structuredClone(args);}catch{return Promise.reject(Object.assign(Error('Invalid native execution payload.'),{noInputSent:true}));}
  return new Promise((resolve,reject)=>{
   const p:Pending={id:++this.serial,owner,op,args:snapshot,opts,resolve,reject,begun:false,dispatched:false,abort:()=>this.fail(Error('Native execution stopped.'))};this.pending=p;
   opts.signal?.addEventListener('abort',p.abort,{once:true});if(opts.assertActive)p.validity=setInterval(()=>{try{opts.assertActive!();}catch(e){this.fail(e instanceof Error?e:Error('Native owner became inactive.'));}},25);
   p.timer=setTimeout(()=>this.fail(Error('Native coordinator startup timeout.')),this.options.startTimeoutMs??5000);
   try{if(!this.child)this.start();if(this.ready)this.begin();}catch(e){this.fail(e instanceof Error?e:Error('Native coordinator unavailable.'));}
   if(opts.signal?.aborted)p.abort();
  });
 }
 private start(){const child=this.options.spawn(),epoch=randomUUID();this.child=child;this.epoch=epoch;this.ready=false;
  child.on('message',message=>{if(this.child!==child||this.epoch!==epoch||!nativeExecutionRecord(message)||message.epoch!==epoch)return;
   if(message.kind==='ready'&&Object.keys(message).sort().join(',')==='epoch,kind'){if(!this.ready){this.ready=true;this.begin();}return;}
   const p=this.pending;if(!p||p.cancelled||message.id!==p.id||message.owner!==p.owner)return;
   if(message.kind==='dispatch'&&Object.keys(message).sort().join(',')==='epoch,id,kind,owner'&&p.begun&&!p.dispatched){
    try{if(p.opts.signal?.aborted)throw Error('Native execution stopped.');p.opts.assertActive?.();p.dispatched=true;p.nativeEpoch=this.broker.dispatch(p.id,p.op,p.args);}catch(e){this.fail(e instanceof Error?e:Error('Native dispatch failed.'));}return;
   }
   if(message.kind!=='result'||!p.dispatched||!p.nativeEpoch||message.nativeEpoch!==p.nativeEpoch||typeof message.ok!=='boolean'||Object.keys(message).some(k=>!['kind','epoch','id','owner','nativeEpoch','ok','value','error','nativeRejection'].includes(k)))return;
   try{if(p.opts.signal?.aborted)throw Error('Native execution stopped.');p.opts.assertActive?.();if(!message.ok&&message.nativeRejection!==true){this.fail(Error(typeof message.error==='string'?message.error:'Native protocol failed.'));return;}this.broker.complete(p.id);this.finish(message.value,message.ok?undefined:Object.assign(Error(nativeErrorText(typeof message.error==='string'?message.error:'Native action failed.')),{nativeRejection:true}));}catch(e){this.fail(e instanceof Error?e:Error('Native completion failed.'));}
  });
  child.on('exit',()=>{if(this.child!==child||this.epoch!==epoch)return;this.child=null;this.ready=false;this.fail(Error('Native execution coordinator exited; operation will not be replayed.'));});
  child.postMessage({kind:'init',epoch});
 }
 private begin(){const p=this.pending;if(!p||p.cancelled||p.begun||!this.child||!this.ready)return;try{if(p.opts.signal?.aborted)throw Error('Native execution stopped.');p.opts.assertActive?.();p.begun=true;clearTimeout(p.timer);p.timer=setTimeout(()=>this.fail(Error('Native execution timeout.')),p.opts.timeoutMs??20000);this.child.postMessage({kind:'begin',epoch:this.epoch,id:p.id,owner:p.owner,op:p.op});}catch(e){this.fail(e instanceof Error?e:Error('Native coordinator transport failed.'));}}
 private nativeEvent(event:NativeProcessBrokerEvent){const p=this.pending;if(event.kind==='stdout'){if(!p||p.cancelled||event.nativeEpoch!==p.nativeEpoch||!this.child)return;try{this.child.postMessage({kind:'data',epoch:this.epoch,id:p.id,owner:p.owner,nativeEpoch:event.nativeEpoch,text:event.text});}catch(e){this.fail(e instanceof Error?e:Error('Native coordinator transport failed.'));}return;}if(p&&p.nativeEpoch&&p.nativeEpoch!==event.nativeEpoch)return;this.fail(Object.assign(Error(event.kind==='spawn-error'?event.message:'Native helper exited.'),event.kind==='spawn-error'&&event.noInputSent?{noInputSent:true}:{}));}
 private fail(reason:Error){const p=this.pending;if(p?.cancelled||this.settling)return;if(p){p.cancelled=reason;clearTimeout(p.timer);clearInterval(p.validity);}const child=this.child;this.child=null;this.ready=false;
  try{child?.postMessage({kind:'cancel',epoch:this.epoch,id:p?.id,owner:p?.owner});}catch{}try{child?.kill();}catch{}
  // Worker death is deliberately not the barrier: only the actual native ChildProcess exit is.
  const barrier=this.broker.terminateAndWait();this.settling=barrier;void barrier.then(()=>{if(this.settling!==barrier)return;this.settling=null;if(this.pending===p&&p)this.finish(undefined,p.cancelled??reason);},()=>{/* Keep the host and journal busy if the exit barrier itself cannot be proved. */});
 }
 private finish(value?:unknown,error?:Error){const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timer);clearInterval(p.validity);p.opts.signal?.removeEventListener('abort',p.abort);error?p.reject(error):p.resolve(value);}
 async settle():Promise<void>{if(this.pending)this.fail(Error('Native execution host stopped.'));if(this.settling)await this.settling;else await this.broker.terminateAndWait();}
 dispose():void{if(this.disposed)return;this.disposed=true;if(this.pending)this.fail(Error('Native execution host disposed.'));else{try{this.child?.kill();}catch{}this.child=null;void this.broker.terminateAndWait();}this.unsubscribe();}
}
