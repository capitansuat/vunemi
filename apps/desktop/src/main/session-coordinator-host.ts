import {randomUUID} from 'node:crypto';
import {sealInterrupted,type ChatMessage,type AgentEvent,type RunStatus,type QuotedSource,type MentionRef,type ApprovalDecision,type HandoffOutcome,type ChoiceAnswer,type PlanDecision,type TaskPermissionRevokeRequest} from '@vunemi/agent-core';
import type {SessionOptions,QueuedMessage} from './session.js';
import {SessionServiceBroker} from './session-service-broker.js';
import {SESSION_SERVICES,validSessionState,fromSessionError,sessionError,type SessionState,type SessionCommand,type SessionBrokerMessage,type SessionContextMethod} from '../shared/session-coordinator.js';
export interface SessionCoordinatorChild {postMessage(message:unknown):void;on(event:'message',listener:(message:unknown)=>void):unknown;on(event:'exit',listener:(code:number)=>void):unknown;kill():boolean}
interface HostOptions {spawn:()=>SessionCoordinatorChild;sessionId:()=>string;options:SessionOptions;locale:()=>string;startTimeoutMs?:number;onPermissionsChanged?:(snapshot:NonNullable<SessionState['permissions']>)=>void}
type RequestOwner={runId:string;requestId:string};
/** Main facade mirrors state only; the real AgentSession is constructed in the utility. */
export class SessionCoordinatorHost {
 private child:SessionCoordinatorChild|null=null;private epoch='';private boundSession='';private ready=false;private disposed=false;private crashed=false;private recovering:Promise<void>|null=null;private nextId=1;private currentRun:string|null=null;private finishedRuns=new Set<string>();private settledRuns=new Set<string>();
 private state:SessionState={running:false,paused:false,queued:[],lastAnswer:'',words:[],grants:[]};
 private commands=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;message:Record<string,unknown>}>();private services=new Map<number,{abort:AbortController;done:Promise<void>;runId:string|null;op:string}>();private contexts=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();private blockedRuns=new Set<string>();private listeners=new Set<(queue:QueuedMessage[])=>void>();private broker:SessionServiceBroker;private history:ChatMessage[]=[];private bootTimer?:ReturnType<typeof setTimeout>;private native=new Map<string,{runId:string;execute:(signal:AbortSignal,emit:(e:AgentEvent)=>void)=>Promise<RunStatus>}>();
 constructor(private readonly opts:HostOptions){this.broker=new SessionServiceBroker(opts.options,opts.sessionId,opts.locale);}
 get running(){return this.state.running||this.recovering!==null||[...this.commands.values()].some(c=>['start','submit','steer','compactNow','native'].includes(String(c.message.method)));}get paused(){return this.state.paused;}get queued(){return this.state.queued.map(q=>structuredClone(q));}get lastAnswer(){return this.state.lastAnswer;}userWords(){return[...this.state.words];}onQueueChange(fn:(queue:QueuedMessage[])=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private update(state:SessionState){this.state=state;if(!state.running)this.currentRun=null;
  const liveEpoch=this.opts.options.taskPermissions?.epoch(),received=state.permissionEpoch;
  const currentEpoch=!liveEpoch||!!received&&['registration','policy','task'].every(k=>received[k as keyof typeof received]===liveEpoch[k as keyof typeof liveEpoch]);
  if(currentEpoch){if(state.permissions&&state.permissions.sessionId===this.boundSession&&(!state.running||state.permissions.runId===this.currentRun))this.opts.onPermissionsChanged?.(state.permissions);this.opts.options.grants.clear();for(const g of state.grants)this.opts.options.grants.add(g);}
  for(const listener of this.listeners)listener(this.queued);
 }
 /** A display mirror is never permission authority; dead/boundary owners cannot keep active badges. */
 private expirePermissionMirror(reason:'run-ended'|'session-changed'|'stopped'){
  const previous=this.state.permissions;if(!previous||!previous.grants.some(g=>g.status==='active'||g.status==='exhausted'))return;
  const snapshot={...previous,revision:previous.revision+1,grants:previous.grants.map(g=>g.status==='active'||g.status==='exhausted'?{...g,status:'expired' as const,endedReason:reason}:g)};
  this.state={...this.state,permissions:snapshot};
  try{this.opts.onPermissionsChanged?.(snapshot);}catch{/* Mirror delivery failure must not interrupt owner cancellation/settlement. */}
 }
 private post(message:Record<string,unknown>){if(!this.child)throw Error('Session coordinator unavailable.');this.child.postMessage({...message,epoch:this.epoch,sessionId:this.boundSession});}
 private startWorker(){if(this.disposed)throw Error('Session coordinator disposed.');const epoch=randomUUID(),sessionId=this.opts.sessionId(),child=this.opts.spawn();this.child=child;this.epoch=epoch;this.boundSession=sessionId;this.ready=false;this.crashed=false;this.blockedRuns.clear();
  child.on('message',message=>{if(this.child!==child||this.epoch!==epoch||!message||typeof message!=='object')return;const m=message as any;if(m.epoch!==epoch||m.sessionId!==this.boundSession)return;try{
   if(['ready','state','event','result'].includes(m.kind)&&!validSessionState(m.state))throw Error('Malformed session state.');
   if(m.kind==='ready'){if(this.ready)return;clearTimeout(this.bootTimer);this.ready=true;if(m.state)this.update(m.state);for(const c of this.commands.values())this.post(c.message);return;}
   if(m.kind==='state'){this.update(m.state);return;}
   if(m.kind==='event'){const event=m.event as AgentEvent;if(!event||typeof event.type!=='string'||typeof event.runId!=='string'||!event.runId)throw Error('Malformed session event.');if(event.type==='run.started'){if(event.quotedSource){if(!this.opts.options.validateQuotedSource)throw Error('Quote validation unavailable.');this.opts.options.validateQuotedSource(event.quotedSource);}this.currentRun=event.runId;}this.opts.options.emit(event);this.update(m.state);if(event.type==='run.finished'){this.finishedRuns.add(event.runId);this.blockedRuns.add(event.runId);}return;}
   if(m.kind==='result'){const p=this.commands.get(m.id);if(!p)return;this.commands.delete(m.id);this.update(m.state);if(m.ok&&p.message.method==='revokeTaskPermission')for(const s of this.services.values())if(s.op.startsWith('tool.')&&s.runId===this.currentRun)s.abort.abort();m.ok?p.resolve(m.value):p.reject(fromSessionError(m.error));return;}
   if(m.kind==='service-cancel'){this.services.get(m.id)?.abort.abort();return;}
   if(m.kind==='context-result'){const p=this.contexts.get(m.id);if(!p)return;this.contexts.delete(m.id);m.ok?p.resolve(m.value):p.reject(fromSessionError(m.error));return;}
   if(m.kind==='service'&&SESSION_SERVICES.includes(m.op)&&Array.isArray(m.args))this.service(m as SessionBrokerMessage,child,epoch,m.sessionId);
   }catch(e){child.kill();this.lost(e instanceof Error?e:Error('Session callback failed.'));}
  });
  child.on('exit',code=>{if(this.child!==child||this.epoch!==epoch)return;this.lost(Error(`Session coordinator exited (${code}); existing work was not replayed.`));});
  this.bootTimer=setTimeout(()=>{if(this.child===child&&!this.ready){child.kill();}},this.opts.startTimeoutMs??5000);
  child.postMessage({kind:'init',epoch,config:{...this.broker.configuration(),history:this.history}});
 }
 private service(request:SessionBrokerMessage,child:SessionCoordinatorChild,epoch:string,sessionId:string){if(this.services.has(request.id))return;const abort=new AbortController();
  const actionService=request.op.startsWith('tool.')||request.op==='authorize'||request.op==='native.execute';
  const cleanup=['history','checkpoint','settled','afterRun','keepOutput'].includes(request.op);
  const guard=()=>{if(actionService&&(!request.runId||request.runId!==this.currentRun))throw Error('Action service requires the current run owner.');if(this.disposed||this.child!==child||this.epoch!==epoch||this.opts.sessionId()!==sessionId||this.crashed||!cleanup&&(abort.signal.aborted||request.runId!==null&&this.blockedRuns.has(request.runId)))throw Error('Session service owner expired.');};
  const context=(contextId:string,method:SessionContextMethod,args:unknown[])=>{guard();return new Promise((resolve,reject)=>{const id=this.nextId++;this.contexts.set(id,{resolve,reject});this.post({kind:'context',id,contextId,method,args});});};
  const done=(async()=>{try{guard();let value:unknown;
   if(request.op==='history'||request.op==='checkpoint')this.history=structuredClone(request.args[0] as ChatMessage[]);
   if(request.op==='native.execute'){const token=String(request.args[0]),native=this.native.get(token);if(!native||native.runId!==request.runId)throw Error('Native lane owner changed.');this.native.delete(token);value=await native.execute(abort.signal,event=>{guard();this.post({kind:'stream',id:request.id,value:event});});}
   else value=await this.broker.invoke(request,{guard,signal:abort.signal,stream:value=>{guard();this.post({kind:'stream',id:request.id,value});},context});
   if(request.op==='settled')this.settledRuns.add(String(request.args[0]));
   if(this.child===child&&!this.crashed)this.post({kind:'service-result',id:request.id,ok:true,value});
  }catch(e){if(this.child===child&&!this.crashed)this.post({kind:'service-result',id:request.id,ok:false,error:sessionError(e)});}finally{this.services.delete(request.id);}})();this.services.set(request.id,{abort,done,runId:request.runId,op:request.op});
 }
 private lost(reason:Error){this.expirePermissionMirror('run-ended');clearTimeout(this.bootTimer);this.child=null;this.ready=false;this.crashed=true;const runId=this.currentRun;this.currentRun=null;for(const s of this.services.values())s.abort.abort();for(const p of this.commands.values())p.reject(reason);this.commands.clear();for(const p of this.contexts.values())p.reject(reason);this.contexts.clear();this.native.clear();this.history=sealInterrupted(this.history,'[Session process interrupted; do not replay unfinished actions.]');
  this.state={...this.state,running:true,paused:false,queued:[]};for(const fn of this.listeners)fn([]);
  this.recovering=(async()=>{await Promise.allSettled([...this.services.values()].map(s=>s.done));if(runId&&!this.settledRuns.has(runId))await this.opts.options.onRunSettled?.(runId);if(runId&&!this.finishedRuns.has(runId))this.opts.options.emit({type:'run.finished',runId,status:'failed',detail:'Session coordinator interrupted; review existing results before any new action.',at:Date.now()});this.broker.clear();})().then(()=>{this.state={...this.state,running:false,queued:[]};this.recovering=null;},()=>{this.state={...this.state,running:true,queued:[]};/* Failed settlement remains blocked for review. */});
 }
 private command(method:SessionCommand,args:unknown[]=[]):Promise<any>{if(this.disposed)return Promise.reject(Error('Session coordinator disposed.'));if(this.recovering)return Promise.reject(Error('Session recovery is waiting for dispatched work to settle.'));if(this.opts.sessionId()!==this.boundSession&&this.child&&method!=='load'&&method!=='reset')return Promise.reject(Error('Load the current conversation before running.'));
  if((method==='load'||method==='reset')&&this.running)return Promise.reject(Error('Stop the active session first.'));
  if(method==='load'||method==='reset')this.expirePermissionMirror('session-changed');
  if(method==='load')this.history=structuredClone(args[0] as ChatMessage[]);if(method==='reset')this.history=[];
  if(method==='revokeTaskPermission'){const r=args[0] as TaskPermissionRevokeRequest,s=this.state.permissions;if(!r||!s||r.sessionId!==this.boundSession||r.runId!==this.currentRun||s.runId!==r.runId||s.sessionId!==r.sessionId||s.revision!==r.expectedRevision||!s.grants.some(g=>g.grantId===r.grantId))return Promise.reject(Error('Stale task permission revoke.'));}
  if(method==='stop'||method==='invalidateTaskPermissions'){if(this.currentRun)this.blockedRuns.add(this.currentRun);for(const s of this.services.values())s.abort.abort();}
  if(method==='load'||method==='reset')this.boundSession=this.opts.sessionId();
  return new Promise((resolve,reject)=>{const id=this.nextId++,message={kind:'command',id,method,args,config:this.broker.configuration()};this.commands.set(id,{resolve,reject,message});try{if(!this.child)this.startWorker();else if(this.ready)this.post(message);}catch(e){this.commands.delete(id);reject(e);}});
 }
 private quote(source:QuotedSource|undefined){return source?this.opts.options.validateQuotedSource?.(source)??(()=>{throw Error('Quote validation unavailable.');})():undefined;}
 submit(text:string,model:string,attachments:string[]=[],mentions:MentionRef[]=[],quote?:QuotedSource){return this.command('submit',[text,model,attachments,mentions,this.quote(quote)]);}
 steer(text:string,model:string,attachments:string[]=[],mentions:MentionRef[]=[],quote?:QuotedSource){return this.command('steer',[text,model,attachments,mentions,this.quote(quote)]);}
 start(goal:string,model:string,attachments:string[]=[],run:Parameters<import('./session.js').AgentSession['start']>[3]={}){return this.command('start',[goal,model,attachments,{...run,...(run.quotedSource&&{quotedSource:this.quote(run.quotedSource)})}]) as Promise<RunStatus|null>;}
 startNativeRecipe(req:{runId:string;goal:string;execute(signal:AbortSignal,emit:(e:AgentEvent)=>void):Promise<RunStatus>}):Promise<RunStatus>{const token=randomUUID();this.native.set(token,{runId:req.runId,execute:req.execute});return (this.command('start',[req.goal,'native-lane',[],{nativeToken:token,runId:req.runId}]) as Promise<RunStatus>).finally(()=>this.native.delete(token));}
 stop(){return this.command('stop');}pause(){return this.command('pause');}resume(){return this.command('resume');}load(history:ChatMessage[]){return this.command('load',[history]);}reset(){return this.command('reset');}drop(id:string){return this.command('drop',[id]);}interrupt(id:string){return this.command('interrupt',[id]);}clearQueue(){return this.command('clearQueue');}forgetWindow(spec:string){this.broker.forgetModel(spec);return this.command('forgetWindow',[spec]);}noteUndone(label:string){return this.command('noteUndone',[label]);}contextInfo(model:string){return this.command('contextInfo',[model]);}compactNow(model:string,runId:string){return this.command('compactNow',[model,runId]);}
 resolveApproval(callId:string,decision:ApprovalDecision,owner:RequestOwner){return this.command('resolveApproval',[callId,decision,owner]) as Promise<boolean>;}canResolveApproval(callId:string,owner:RequestOwner){return this.command('canResolveApproval',[callId,owner]) as Promise<boolean>;}resolveHandoff(callId:string,outcome:HandoffOutcome,owner:RequestOwner){return this.command('resolveHandoff',[callId,outcome,owner]) as Promise<boolean>;}resolveChoice(runId:string,callId:string,answer:ChoiceAnswer,owner:RequestOwner){return this.command('resolveChoice',[runId,callId,answer,owner]) as Promise<boolean>;}resolvePlan(decision:PlanDecision,owner:RequestOwner){return this.command('resolvePlan',[decision,owner]) as Promise<boolean>;}resolveTaskApproval(request:unknown){return this.command('resolveTaskApproval',[request]);}listTaskPermissions(request:unknown){return this.command('listTaskPermissions',[request]);}revokeTaskPermission(request:TaskPermissionRevokeRequest){return this.command('revokeTaskPermission',[request]);}invalidateTaskPermissions(reason:string,epoch?:unknown){return this.command('invalidateTaskPermissions',[reason,epoch]);}
 dispose(){if(this.disposed)return;this.expirePermissionMirror('stopped');this.disposed=true;for(const s of this.services.values())s.abort.abort();this.child?.kill();for(const p of this.commands.values())p.reject(Error('Session coordinator disposed.'));this.commands.clear();clearTimeout(this.bootTimer);}
}
