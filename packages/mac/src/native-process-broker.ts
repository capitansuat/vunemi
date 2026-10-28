import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
export type NativeProcessBrokerEvent=
 |{kind:'stdout';nativeEpoch:string;text:string}
 |{kind:'exit';nativeEpoch:string;code:number|null;signal:NodeJS.Signals|null}
 |{kind:'spawn-error';nativeEpoch:string;message:string;noInputSent:boolean};
const refusal=(message:string)=>Object.assign(Error(message),{noInputSent:true,deliveryUnknown:false});
/** Main owns this actual child handle. A worker exit is never a native-exit barrier. */
export class NativeProcessBroker {
 private child:ChildProcessWithoutNullStreams|null=null;
 private nativeEpoch='';
 private active:{id:number;op:string}|null=null;
 private listeners=new Set<(event:NativeProcessBrokerEvent)=>void>();
 private terminating:Promise<void>|null=null;
 private settleTermination:(()=>void)|undefined;
 private escalation:ReturnType<typeof setTimeout>|undefined;
 private force:ReturnType<typeof setTimeout>|undefined;
 constructor(private readonly binary:string){if(!isAbsolute(binary))throw refusal('Native helper path must be absolute.');}
 subscribe(listener:(event:NativeProcessBrokerEvent)=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private emit(event:NativeProcessBrokerEvent):void{for(const listener of [...this.listeners]){try{listener(event);}catch{/* A failed consumer must not release the actual child barrier. */}}}
 dispatch(id:number,op:string,args:Record<string,unknown>):string{
  if(this.terminating||this.active)throw refusal('Native broker busy; no request queued.');
  if(!Number.isSafeInteger(id)||id<1||typeof op!=='string'||!op||op.length>128||!args||typeof args!=='object'||Array.isArray(args))throw refusal('Invalid native dispatch.');
  if(!existsSync(this.binary))throw refusal('Native helper unavailable.');
  let frame:string;try{frame=JSON.stringify({id,op,args})+'\n';}catch{throw refusal('Invalid native payload.');}
  this.active={id,op};
  try{const child=this.start();child.stdin.write(frame);return this.nativeEpoch;}
  catch(error){if(!this.child)this.active=null;throw error;}
 }
 complete(id:number):void{if(this.terminating||!this.active||this.active.id!==id)throw refusal('Foreign or unsettled native completion.');this.active=null;}
 private start():ChildProcessWithoutNullStreams{
  if(this.child)return this.child;
  const nativeEpoch=randomUUID(),child=spawn(this.binary,[],{stdio:['pipe','pipe','pipe']}),decoder=new StringDecoder('utf8');
  this.child=child;this.nativeEpoch=nativeEpoch;
  child.stdout.on('data',(chunk:Buffer)=>{if(this.child===child){const text=decoder.write(chunk);if(text)this.emit({kind:'stdout',nativeEpoch,text});}});
  // Drain diagnostics without persisting document text or values in application logs.
  child.stderr.on('data',()=>{});
  const failed=(error:Error)=>{
   if(this.child!==child)return;
   const noInputSent=child.pid===undefined;
   if(noInputSent){this.child=null;this.active=null;this.releaseTermination();}
   this.emit({kind:'spawn-error',nativeEpoch,message:error.message,noInputSent});
  };
  child.on('error',failed);child.stdin.on('error',failed);
  child.once('exit',(code,signal)=>{
   if(this.child!==child)return;
   const tail=decoder.end();if(tail)this.emit({kind:'stdout',nativeEpoch,text:tail});
   this.child=null;this.active=null;this.releaseTermination();
   this.emit({kind:'exit',nativeEpoch,code,signal});
  });
  return child;
 }
 private releaseTermination():void{clearTimeout(this.escalation);clearTimeout(this.force);this.escalation=undefined;this.force=undefined;const settle=this.settleTermination;this.settleTermination=undefined;this.terminating=null;settle?.();}
 terminateAndWait():Promise<void>{
  if(this.terminating)return this.terminating;
  const child=this.child;if(!child)return Promise.resolve();
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  this.terminating=new Promise<void>(resolve=>{this.settleTermination=resolve;});
  const alive=()=>this.child===child&&child.exitCode===null&&child.signalCode===null;
  const signal=(value:NodeJS.Signals)=>{try{if(alive())child.kill(value);}catch{/* No kill return or error is proof of exit. Keep waiting. */}};
  const terminate=()=>{signal('SIGTERM');this.force=setTimeout(()=>signal('SIGKILL'),500);};
  if(this.active?.op==='background_drag'){signal('SIGUSR1');this.escalation=setTimeout(terminate,2000);}else terminate();
  return this.terminating;
 }
 dispose():void{void this.terminateAndWait();}
}
