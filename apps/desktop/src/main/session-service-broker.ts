import {createModel,type ChatModel,type ChatRequest,type ToolContext,type ToolDef,type ActionClass} from '@vunemi/agent-core';
import type {SessionOptions} from './session.js';
import type {SessionConfiguration,SessionBrokerMessage,SessionContextMethod,SessionToolMetadata} from '../shared/session-coordinator.js';
interface Handle {tool:ToolDef;source:string;revision:number;args:Record<string,unknown>;serialized:string;runId:string;used:boolean}
export interface SessionBrokerChannel {guard():void;signal:AbortSignal;stream(chunk:unknown):void;context(contextId:string,method:SessionContextMethod,args:unknown[]):Promise<unknown>}
/** Main-owned services. Functions, AbortSignals, provider credentials and prepared args never serialize. */
export class SessionServiceBroker {
 private handles=new Map<string,Handle>();private models=new Map<string,ChatModel>();
 constructor(readonly options:SessionOptions,private readonly sessionId:()=>string,private readonly locale:()=>string){}
 configuration():SessionConfiguration{const o=this.options,tools=o.tools.sources().flatMap(source=>[...o.tools.list(),...o.tools.listSwitchedOff()].filter(t=>o.tools.sourceOf(t.name)===source.source).map(t=>({source:source.source,enabled:source.enabled,revision:o.tools.revisionOf(source.source),definition:Object.fromEntries(['name','description','parameters','actionClass','takesForeground','alwaysAsk','allowSessionApproval','onDemand','untrustedOutput','record','ephemeral','firstPartChars','saves'].filter(k=>(t as unknown as Record<string,unknown>)[k]!==undefined).map(k=>[k,(t as unknown as Record<string,unknown>)[k]])) as SessionToolMetadata['definition'],...(t.wantedFor&&{wantedFor:{source:t.wantedFor.source,flags:t.wantedFor.flags}}),...(t.avoidFor&&{avoidFor:{source:t.avoidFor.source,flags:t.avoidFor.flags}}),taskPermission:!!t.taskPermission})));return{sessionId:this.sessionId(),locale:this.locale(),tools,instructions:o.instructions?.()??'',chatInstructions:o.chatInstructions?.()??'',planBeforeRun:o.planBeforeRun?.()===true,areas:o.areas?.()??[],latestTask:o.latestTask?.(),openPage:o.openPage?.()??null,notesIndex:o.notesIndex?.()??null,grants:[...o.grants],permissionEpoch:o.taskPermissions?.epoch(),hasTaskPermissions:!!o.taskPermissions,offers:Object.fromEntries(tools.flatMap(t=>{const v=o.switchedOff?.(t.definition.name);return v?[[t.definition.name,v]]:[];})),...(o.fileRoots&&{fileRoots:o.fileRoots()})};}
 private model(spec:string){let m=this.models.get(spec);if(!m){m=this.options.modelFactory?.(spec)??createModel(spec,this.options.modelConfig?.(spec));this.models.set(spec,m);}return m;}
 forgetModel(spec:string){this.models.delete(spec);}
 clear(){this.handles.clear();this.models.clear();}
 async invoke(request:SessionBrokerMessage,channel:SessionBrokerChannel):Promise<unknown>{
  const o=this.options,a=request.args;channel.guard();
  const done=async(value:unknown)=>{const v=await value;channel.guard();return v;};
  const checkContext={runId:request.runId??'',signal:channel.signal,userGoal:typeof a[3]==='string'?a[3]:undefined,assertToolActive:channel.guard};
  if(request.op==='refresh')return this.configuration();
  if(request.op==='prepareModel'){const result=await o.prepareModel?.(String(a[0]));this.models.delete(String(a[0]));channel.guard();return{result,config:this.configuration(),cacheStableTools:this.model(String(a[0])).cacheStableTools===true};}
  if(request.op.startsWith('model.')){const model=this.model(String(a[0]));if(request.op==='model.chat'){const req=a[1] as Omit<ChatRequest,'signal'>;return done(model.chat({...req,signal:channel.signal},chunk=>{channel.guard();channel.stream(chunk);}));}if(request.op==='model.contextWindow')return done(model.contextWindow?.()??null);if(request.op==='model.vision')return done(model.vision?.()??false);return done(model.firstTokenOdds?.(a[1] as never,a[2] as never,channel.signal)??null);}
  if(request.op==='tool.prepare'){
   if(!request.runId)throw Error('Tool requires emitted run owner.');const [name,id,args]=a as [string,string,Record<string,unknown>];if(typeof id!=='string'||id.length>256||this.handles.size>=512)throw Error('Invalid prepared tool handle.');
   const tool=o.tools.getAny(name),source=o.tools.sourceOf(name);if(!tool||!source)throw Error('Tool unavailable.');const key=`${request.runId}:${id}`;if(this.handles.has(key))throw Error('Tool handle already prepared.');
   const handle:Handle={tool,source,revision:o.tools.revisionOf(source),args:structuredClone(args),serialized:JSON.stringify(args),runId:request.runId,used:false};this.handles.set(key,handle);
   let preview:string|undefined;try{preview=await tool.preview?.(handle.args);}catch{/* Match core safePreview: check still decides whether the tool is usable. */}this.assertHandle(handle,channel,false);
   let actionClass:ActionClass=tool.actionClass;try{actionClass=tool.classify?.(handle.args)??actionClass;}catch{}
   let scope:string|undefined,path:string|undefined;try{scope=tool.approvalScope?.(handle.args);}catch{}try{path=tool.resolveFile?.(handle.args);}catch{}
   return{preview,actionClass,scope,path,alwaysAsk:tool.alwaysAskWhen?.(handle.args)===true};
  }
  if(request.op.startsWith('tool.')){
   const [name,id,args]=a as [string,string,Record<string,unknown>];const h=this.handles.get(`${request.runId}:${id}`);if(!h||h.tool.name!==name||h.runId!==request.runId||h.serialized!==JSON.stringify(args))throw Error('Prepared tool owner or arguments changed.');this.assertHandle(h,channel,request.op==='tool.run');
   const guard=()=>this.assertHandle(h,channel,request.op==='tool.run');checkContext.assertToolActive=guard;
   if(request.op==='tool.check')return done(h.tool.check?.(h.args,checkContext)??null);
   if(request.op==='tool.permission.prepare')return done(h.tool.taskPermission?.prepare(h.args,checkContext)??null);
   if(request.op==='tool.permission.revalidate')return done(h.tool.taskPermission?.revalidate(h.args,a[4] as never,checkContext)??false);
   if(request.op!=='tool.run'||h.used)throw Error('Tool handle already consumed.');h.used=true;
   const contextId=String(a[4]),contextState=a[5] as {taskReceipts?:unknown;desktopDocumentState?:unknown}|undefined;
   const notify=(method:SessionContextMethod,...args:unknown[])=>channel.context(contextId,method,args);
   const inform=(method:SessionContextMethod,...args:unknown[])=>{void notify(method,...args).catch(()=>{});};
   const ctx:ToolContext={runId:h.runId,callId:String(a[6]),userGoal:checkContext.userGoal,signal:channel.signal,assertToolActive:guard,handoff:reason=>notify('handoff',reason) as Promise<boolean>,offerUndo:(label,undo)=>{guard();o.onUndoOffered?.({callId:String(a[6]),tool:name,label,undo});},attach:artifact=>{inform('attach',artifact);},gallery:items=>{inform('gallery',items);},produced:item=>{inform('produced',item);},openTools:group=>{inform('openTools',group);},updateTask:input=>notify('updateTask',input) as Promise<void>,taskReceipts:()=>contextState?.taskReceipts as never??[],desktopDocumentState:()=>contextState?.desktopDocumentState as never??{receipts:[],uncertain:false},recordDesktopAppendIntent:()=>notify('recordDesktopAppendIntent') as Promise<void>,recordDesktopEvidence:evidence=>{inform('recordDesktopEvidence',evidence);},recordOutcomeEvidence:evidence=>{inform('recordOutcomeEvidence',evidence);}};
   const output=await h.tool.run(h.args,ctx);guard();let modelOutput=output;try{modelOutput=await h.tool.forModel?.(output)??output;}catch{/* A model-facing projection cannot invalidate an already completed tool effect. */}return{output,modelOutput};
  }
  switch(request.op){
   case 'authorize':return done(o.authorize?.(a[0] as never));
   case 'grant.before':return done(o.standingGrant?.()?.before(String(a[0]),a[1],channel.signal)??{refuse:'This task has no standing permission. Nothing was done.'});
   case 'grant.allows':return done(o.standingGrant?.()?.allows(String(a[0]),a[1])??false);
   case 'grant.uncertain':o.standingGrant?.()?.onUncertain?.();return null;
   case 'redact':return done(o.redact?.(String(a[0]))??String(a[0]));
   case 'loadImage':return done(o.loadImage?.(a[0] as never));
   case 'readImageText':return done(o.readImageText?.(a[0] as never));
   case 'recall':return done(o.recall?.(String(a[0]))??{notes:[],topic:[]});
   case 'readMentions':return done(o.readMentions?.(a[0] as never,Number(a[1]))??[]);
   case 'libraryIndex':return done(o.libraryIndex?.(String(a[0]),new Set(a[1] as string[]))??null);
   case 'switchOn':{const name=String(a[0]),source=o.tools.sourceOf(name),revision=source?o.tools.revisionOf(source):undefined;await o.switchOn?.(name);channel.guard();if(source&&o.tools.isEnabled(source))for(const h of this.handles.values())if(h.runId===request.runId&&h.source===source&&h.revision===revision&&o.tools.getAny(h.tool.name)===h.tool)h.revision=o.tools.revisionOf(source);return this.configuration();}
   case 'untrusted':o.onUntrustedOutput?.(String(a[0]),String(a[1]));return;
   case 'history':o.onHistory?.(a[0] as never);return;
   case 'checkpoint':await o.onCheckpoint?.(a[0] as never);return;
   case 'settled':await o.onRunSettled?.(String(a[0]));for(const[k,h]of this.handles)if(h.runId===a[0])this.handles.delete(k);return;
   case 'afterRun':o.afterRun?.({runId:String(a[0]),model:this.model(String(a[1])),words:a[2] as string[]});return;
   case 'keepOutput':return o.keptOutputs?.keep(String(a[0]),String(a[1]),Number(a[2]));
   default:throw Error('Unknown session service.');
  }
 }
 private assertHandle(h:Handle,c:SessionBrokerChannel,requireEnabled=true){c.guard();if(this.options.tools.getAny(h.tool.name)!==h.tool||this.options.tools.sourceOf(h.tool.name)!==h.source||this.options.tools.revisionOf(h.source)!==h.revision||requireEnabled&&!this.options.tools.isEnabled(h.source))throw Error('Tool registration changed.');}
}
