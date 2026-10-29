import {randomUUID} from 'node:crypto';
import {AgentSession,type SessionOptions} from '../main/session.js';
import {setLocale,isLocale} from '@vunemi/i18n';
import {Roots} from '@vunemi/files';
import {ToolRegistry,TaskPermissionStore,copyQuotedSource,tasksFromEvents,type ChatModel,type ChatRequest,type ToolContext,type ToolDef,type AgentEvent,type OutputKeeper,type TaskPermissionEpoch} from '@vunemi/agent-core';
import {SESSION_COMMANDS,sessionError,fromSessionError,type SessionConfiguration,type SessionState,type SessionService,type SessionContextMethod} from '../shared/session-coordinator.js';
/**
 * The agent names a file through these tools with arguments it made itself,
 * to compare the file a request names with the one a tool saved. Main never
 * prepared those, so they are resolved here against a copy of the open folders.
 */
const FILE_ACCESS:Record<string,'read'|'write'>={files_read:'read',files_write:'write',files_edit:'write'};
export interface SessionWorkerPort {postMessage(message:unknown):void;on(event:'message',listener:(event:{data:unknown})=>void):unknown}
/** The actual AgentSession, including queue/history/approval owners, lives here. */
export function serveSessionCoordinator(port:SessionWorkerPort):()=>void{
 let epoch='',sessionId='',config:SessionConfiguration,fileRoots:Roots|null=null,session:AgentSession|undefined,closed=false,currentRun:string|null=null,nextId=1,preparationGeneration=0;
 const commandIds=new Set<number>();
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;stream?:(v:any)=>void;cleanup:()=>void}>(),contexts=new Map<string,ToolContext>(),tools=new ToolRegistry(),grants=new Set<string>();
 const modelFlags=new Map<string,boolean>();
 const permissions=new TaskPermissionStore(()=>{if(session)sendState();});
 const post=(message:Record<string,unknown>)=>{if(!closed)port.postMessage({...message,epoch,sessionId});};
 const state=():SessionState=>({running:session?.running??false,paused:session?.paused??false,queued:session?.queued??[],lastAnswer:session?.lastAnswer??'',words:session?.userWords()??[],grants:[...grants],permissions:permissions.snapshot(),permissionEpoch:config?.permissionEpoch});
 const sendState=()=>post({kind:'state',state:state()});
 const rpc=(op:SessionService,args:unknown[]=[],signal?:AbortSignal,stream?:(v:any)=>void):Promise<any>=>{
  if(closed||signal?.aborted)return Promise.reject(Error('Session service stopped.'));const id=nextId++;
  return new Promise((resolve,reject)=>{const abort=()=>post({kind:'service-cancel',id});signal?.addEventListener('abort',abort,{once:true});pending.set(id,{resolve,reject,stream,cleanup:()=>signal?.removeEventListener('abort',abort)});post({kind:'service',id,op,args,runId:currentRun});});
 };
 const workEvents:AgentEvent[]=[];
 const emitted=(event:AgentEvent)=>{workEvents.push(event);config.latestTask=tasksFromEvents(workEvents).at(-1)??config.latestTask;if(event.type==='run.started')currentRun=event.runId;post({kind:'event',event,state:state()});if(event.type==='run.finished')currentRun=null;};
 function apply(next:SessionConfiguration,rebuild=true){config=next;fileRoots=next.fileRoots?Roots.from(next.fileRoots):null;sessionId=next.sessionId;if(isLocale(next.locale))setLocale(next.locale);if(rebuild){for(const s of tools.sources())tools.unregister(s.source);for(const meta of next.tools){const handles=new WeakMap<object,{id:string;prepared?:any;modelOutputs:Map<string,string>}>();
  const handle=(args:object)=>{let v=handles.get(args);if(!v){v={id:randomUUID(),modelOutputs:new Map()};handles.set(args,v);}return v;};
  const argsFor=(args:object,goal?:string)=>[meta.definition.name,handle(args).id,args,goal];
  const proxy:ToolDef={...meta.definition,...(meta.wantedFor&&{wantedFor:new RegExp(meta.wantedFor.source,meta.wantedFor.flags)}),...(meta.avoidFor&&{avoidFor:new RegExp(meta.avoidFor.source,meta.avoidFor.flags)}),
   preview:async args=>{const h=handle(args);if(!h.prepared)h.prepared=await rpc('tool.prepare',argsFor(args));return h.prepared.preview;},
   classify:args=>{const p=handle(args).prepared;if(!p)throw Error('Tool not prepared.');return p.actionClass;},alwaysAskWhen:args=>handle(args).prepared?.alwaysAsk===true,approvalScope:args=>handle(args).prepared?.scope,resolveFile:args=>{const path=handle(args).prepared?.path;if(path)return path;const access=FILE_ACCESS[meta.definition.name];if(!access||!fileRoots)throw Error('File not prepared.');return fileRoots.resolve(String(args.path??''),access);},
   check:async(args,c)=>{if(!handle(args).prepared)handle(args).prepared=await rpc('tool.prepare',argsFor(args),c?.signal);return rpc('tool.check',argsFor(args,c?.userGoal),c?.signal);},
   run:async(args,ctx)=>{const id=randomUUID();contexts.set(id,ctx);try{const result=await rpc('tool.run',[...argsFor(args,ctx.userGoal),id,{taskReceipts:ctx.taskReceipts?.(),desktopDocumentState:ctx.desktopDocumentState?.()},ctx.callId],ctx.signal);handle(args).modelOutputs.set(result.output,result.modelOutput);return result.output;}finally{contexts.delete(id);}},
   forModel:raw=>raw,
  };
  // forModel is called immediately after the matching run; no callback/function crosses IPC.
  let modelCopy: {raw:string;text:string}|undefined;const originalRun=proxy.run;proxy.run=async(args,ctx)=>{const raw=await originalRun(args,ctx);modelCopy={raw,text:handle(args).modelOutputs.get(raw)??raw};return raw;};proxy.forModel=raw=>modelCopy?.raw===raw?modelCopy.text:raw;
  if(meta.taskPermission)proxy.taskPermission={prepare:(args,c)=>rpc('tool.permission.prepare',argsFor(args,c.userGoal),c.signal),revalidate:(args,d,c)=>rpc('tool.permission.revalidate',[...argsFor(args,c.userGoal),d],c.signal)};
  tools.register(proxy,meta.source);
 }for(const meta of next.tools)if(!meta.enabled)tools.setEnabled(meta.source,false);}
 }
 function model(spec:string):ChatModel{return{id:spec,get cacheStableTools(){return modelFlags.get(spec)??false;},chat:(req,onChunk)=>{const{signal,...data}=req;return rpc('model.chat',[spec,data],signal,onChunk);},contextWindow:()=>rpc('model.contextWindow',[spec]),vision:()=>rpc('model.vision',[spec]),firstTokenOdds:(messages,candidates,signal)=>rpc('model.firstTokenOdds',[spec,messages,candidates],signal)};}
 function create(){
  const keeper:OutputKeeper={keep:(tool,text,part)=>rpc('keepOutput',[tool,text,part]),read:()=>{throw Error('Read kept output through output_read.');},search:()=>{throw Error('Search kept output through output_search.');},toolOf:()=>undefined};
  const opts:SessionOptions={tools,grants,onStateChanged:sendState,keptOutputs:keeper,modelFactory:model,emit:emitted,validateQuotedSource:copyQuotedSource,
   ...(config.hasTaskPermissions&&{taskPermissions:{store:permissions,sessionId:()=>sessionId,epoch:()=>config.permissionEpoch??{registration:0,policy:0,task:0} as TaskPermissionEpoch}}),
   instructions:()=>config.instructions,chatInstructions:()=>config.chatInstructions,planBeforeRun:()=>config.planBeforeRun,areas:()=>config.areas,latestTask:()=>config.latestTask,openPage:()=>config.openPage,notesIndex:()=>config.notesIndex,
   prepareModel:async spec=>{const generation=++preparationGeneration;const value=await rpc('prepareModel',[spec]);if(closed||generation!==preparationGeneration)throw Error('Stale session preparation.');modelFlags.set(spec,value.cacheStableTools===true);apply(value.config);return value.result;},authorize:req=>rpc('authorize',[req]),switchedOff:name=>config.offers[name] as never??null,switchOn:async name=>{config=await rpc('switchOn',[name]);for(const m of config.tools)if(tools.isEnabled(m.source)!==m.enabled)tools.setEnabled(m.source,m.enabled);},
   onUntrustedOutput:(text,source)=>{void rpc('untrusted',[text,source]).catch(()=>session?.stop());},redact:text=>rpc('redact',[text]),loadImage:path=>rpc('loadImage',[path]),readImageText:path=>rpc('readImageText',[path]),recall:goal=>rpc('recall',[goal]),
   readMentions:(refs,total)=>rpc('readMentions',[refs,total]),libraryIndex:(goal,given)=>rpc('libraryIndex',[goal,[...given]]),onHistory:history=>{void rpc('history',[history]).catch(()=>session?.stop());},onCheckpoint:history=>{void rpc('checkpoint',[history]).catch(()=>session?.stop());},onRunSettled:runId=>rpc('settled',[runId]),afterRun:run=>{void rpc('afterRun',[run.runId,run.model.id,run.words]).catch(()=>{});}};
  session=new AgentSession(opts);session.onQueueChange(sendState);if(config.history)session.load(config.history);
 }
 port.on('message',({data})=>{if(closed||!data||typeof data!=='object')return;const m=data as any;
  if(m.kind==='init'&&!epoch&&typeof m.epoch==='string'&&m.config){epoch=m.epoch;apply(m.config);for(const grant of config.grants)grants.add(grant);create();post({kind:'ready',state:state()});return;}
  if(!session||m.epoch!==epoch)return;
  if(m.kind==='service-result'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);p.cleanup();m.ok?p.resolve(m.value):p.reject(fromSessionError(m.error));return;}
  if(m.kind==='stream'){pending.get(m.id)?.stream?.(m.value);return;}
  if(m.kind==='context'){const ctx=contexts.get(m.contextId);void(async()=>{if(!ctx||ctx.signal.aborted)throw Error('Expired tool context.');ctx.assertToolActive?.();const method=m.method as SessionContextMethod;if(!['handoff','updateTask','attach','gallery','produced','openTools','recordDesktopAppendIntent','recordDesktopEvidence','recordOutcomeEvidence'].includes(method))throw Error('Unknown context callback.');const fn=ctx[method];return typeof fn==='function'?(fn as (...args:unknown[])=>unknown)(...m.args):undefined;})().then(value=>post({kind:'context-result',id:m.id,ok:true,value}),error=>post({kind:'context-result',id:m.id,ok:false,error:sessionError(error)}));return;}
  if(m.kind!=='command'||!SESSION_COMMANDS.includes(m.method)||!Number.isSafeInteger(m.id)||m.id<1||!Array.isArray(m.args)||Object.keys(m).some(k=>!['kind','epoch','sessionId','id','method','args','config'].includes(k))||commandIds.has(m.id))return;
  if(commandIds.size>=10000){post({kind:'result',id:m.id,ok:false,error:sessionError(Error('Session command limit reached. Start a fresh process.')),state:state()});return;}commandIds.add(m.id);
  if(m.sessionId!==sessionId&&m.method!=='load'&&m.method!=='reset')return;
  if(['stop','steer','interrupt','load','reset'].includes(m.method))preparationGeneration++;
  void(async()=>{if(m.config){if(m.config.sessionId!==sessionId&&session!.running)throw Error('Session still running.');apply(m.config,!session!.running);}
   if(m.method==='invalidateTaskPermissions'){grants.clear();config.permissionEpoch=m.args[1]??config.permissionEpoch;permissions.expire(m.args[0]??'session-changed');return permissions.snapshot();}
   if(m.method==='state')return state();
   if(m.method==='load'||m.method==='reset'){workEvents.length=0;grants.clear();}
   if(m.method==='start'&&m.args[3]?.nativeToken){const lane=m.args[3];return session!.startNativeRecipe({runId:lane.runId,goal:m.args[0],execute:(signal,emit)=>rpc('native.execute',[lane.nativeToken],signal,emit)});}
   const fn=(session as any)[m.method];if(typeof fn!=='function')throw Error('Unknown session command.');return await fn.apply(session,m.args);
  })().then(value=>post({kind:'result',id:m.id,ok:true,value,state:state()}),error=>post({kind:'result',id:m.id,ok:false,error:sessionError(error),state:state()}));
 });
 return()=>{closed=true;session?.stop();for(const p of pending.values()){p.cleanup();p.reject(Error('Session coordinator closed.'));}pending.clear();contexts.clear();};
}
