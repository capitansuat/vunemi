import {randomUUID,createHash} from 'node:crypto';
import {openSync,closeSync,fsyncSync,writeSync,readFileSync,existsSync,mkdirSync,lstatSync,constants} from 'node:fs';
import {dirname} from 'node:path';
export interface HostObservation {foregroundPid:number;cursor:{x:number;y:number};unlocked:boolean}
export interface BoundOptions {operationJournalPath?:string;observeHost?:()=>Promise<HostObservation>}
export interface PageState {frameId:string;loaderId:string;url:string;width:number;height:number;scale:number;scrollX:number;scrollY:number}
export interface BoundAction {bindingId:string;action:'click'|'menu'|'scroll'|'drag';ref:number;toRef?:number;x?:number;y?:number;toX?:number;toY?:number;delta?:number;steps?:number}
export interface StrictDriver {
 strictState():Promise<PageState>;
 strictPrepare(args:BoundAction):Promise<unknown>;
 strictPerform(args:BoundAction,plan:unknown,guard:()=>Promise<void>):Promise<void>;
 strictRelease():Promise<void>;
 strictScreenshot?():Promise<Buffer>;
 strictVisualState?(ref?:number):Promise<Record<string,string>>;
 strictReadback(ref?:number):Promise<{text:string;scrollX:number;scrollY:number;target?:unknown;title?:string;refs?:number[];labels?:Array<{ref:number;role:string;name:string}>}>;
}
export interface BoundAdapter {targetId:string;ownerId:string;kind:'managed-browser'|'owned-web-content';hostPid?:number;headless?:true;driver:StrictDriver;assertOwned():Promise<void>}
interface Binding {bindingId:string;runId:string;adapter:BoundAdapter;state:PageState;used:boolean;refs:ReadonlySet<number>;refLines:ReadonlyMap<number,string>;title:string;imageObserved?:boolean;visualState?:Record<string,string>}
interface Plan {binding:Binding;fingerprint:string;target:unknown}
interface JournalRow {version:1;operationId:string;ownerId:string;targetId:string;runId:string;phase:'prepared'|'dispatched'|'result'|'unknown';at:number}
const journalInfo=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function noInput(message:string){return Object.assign(new Error(`${message} No input sent.`),{noInputSent:true,retryable:false});}
/** Strict actions are bound independently of the legacy controller's current-tab API. */
export class BoundActions {
 private readonly bindings=new Map<string,Binding>();
 private readonly plans=new WeakMap<object,Plan>();
 private readonly active=new Map<string,{runId:string;done:Promise<void>}>();
 private readonly blocked=new Set<string>();
 private readonly closed=new Set<string>();
 private journalUnavailable=false;
 private disposed=false;
 constructor(private readonly options:BoundOptions,private readonly resolve:(tab?:number)=>Promise<BoundAdapter>){
  const path=options.operationJournalPath;
  try {
   if(path&&journalInfo(path)){
    const info=journalInfo(path)!;if(!info.isFile()||info.isSymbolicLink()||info.size>8_000_000)throw Error('Unsafe browser journal.');
    const rows=readFileSync(path,'utf8'),latest=new Map<string,JournalRow>();
    for(const line of rows.split('\n').filter(Boolean)){
     const row=JSON.parse(line) as JournalRow;
     const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!v.includes('\0');
     if(row.version!==1||!id(row.operationId)||!id(row.ownerId)||!id(row.targetId)||!id(row.runId)||!Number.isSafeInteger(row.at)||row.at<=0||!['prepared','dispatched','result','unknown'].includes(row.phase))throw Error('Invalid journal row.');
     const prior=latest.get(row.operationId);
     if(!prior&&row.phase!=='prepared'||prior&&(prior.ownerId!==row.ownerId||prior.targetId!==row.targetId||prior.runId!==row.runId||prior.phase==='prepared'&&row.phase!=='dispatched'||prior.phase==='dispatched'&&!['result','unknown'].includes(row.phase)||['result','unknown'].includes(prior.phase)))throw Error('Invalid journal transition.');
     latest.set(row.operationId,row);
    }
    for(const row of latest.values())if(row.phase!=='result')this.blocked.add(`${row.ownerId}\0${row.targetId}`);
   }
  }catch{this.journalUnavailable=true;}
 }

 async observe(runId:string,tab?:number){
  if(this.disposed||!runId||this.closed.has(runId))throw noInput('A live run owner is required.');
  const adapter=await this.resolve(tab);await adapter.assertOwned();const before=await adapter.driver.strictState();const readback=await adapter.driver.strictReadback();const state=await adapter.driver.strictState();if(fingerprint(before)!==fingerprint(state))throw noInput('Document changed while observing; observe again.');
  if(!state.frameId||!state.loaderId)throw noInput('A stable document identity is unavailable.');
  const bindingId=randomUUID();this.bindings.set(bindingId,{bindingId,runId,adapter,state,used:false,refs:new Set(readback.refs??[]),refLines:new Map((readback.labels??[]).filter(label=>Number.isSafeInteger(label.ref)&&typeof label.role==='string'&&typeof label.name==='string').map(label=>[label.ref,`${label.role.slice(0,64)} ${JSON.stringify(label.name.slice(0,200))}`])),title:readback.title??new URL(state.url).origin});
  return {kind:"bound-browser-observation" as const,version:1,controlMode:"backgroundStrict" as const,bindingId,targetId:adapter.targetId,backend:adapter.kind,title:readback.title??null,origin:new URL(state.url).origin,snapshotId:bindingId,...state,readback,observationOnly:true as const,screenshotObserved:false,coordinates:"viewport-css-pixels" as const};
 }
 private binding(args:BoundAction,runId:string){
  const binding=this.bindings.get(args.bindingId);if(!binding||binding.runId!==runId)throw noInput('Binding run owner does not match.');
  if(this.disposed||this.closed.has(runId))throw noInput('This run owner is closed.');
  if(binding.used)throw noInput('This observation was already used; observe again.');
  if(this.blocked.has(this.key(binding)))throw noInput('Prior browser delivery is unknown; target is blocked.');
  if(!['click','menu','scroll','drag'].includes(args.action)||!Number.isSafeInteger(args.ref)||args.ref<=0)throw noInput('Invalid bounded browser action.');
  if(!binding.refs.has(args.ref)||args.toRef!==undefined&&(!Number.isSafeInteger(args.toRef)||!binding.refs.has(args.toRef)))throw noInput('This target ref was not returned by the bound observation.');
  return binding;
 }
 private key(binding:Binding){return `${binding.adapter.ownerId}\0${binding.adapter.targetId}`;}
 private async host(binding?:Binding){
  const host=await this.options.observeHost?.();
  if(!host||host.unlocked!==true||!Number.isSafeInteger(host.foregroundPid)||host.foregroundPid<=0||!Number.isFinite(host.cursor.x)||!Number.isFinite(host.cursor.y))throw noInput('Verified unlocked host observation is unavailable.');
  if(binding?.adapter.headless!==true){
   if(!Number.isSafeInteger(binding?.adapter.hostPid)||!binding?.adapter.hostPid||binding.adapter.hostPid<=0)throw noInput('Target host identity is unavailable.');
   if(host.foregroundPid===binding.adapter.hostPid)throw noInput('The target host is foreground; user takeover is active.');
  }
  return structuredClone(host);
 }
 private async visualFresh(binding:Binding,args:BoundAction){
  if(!(args.action==='drag'&&args.toRef===undefined)&&args.x===undefined&&args.y===undefined)return;
  const current=await binding.adapter.driver.strictVisualState?.(args.ref),expected=binding.visualState?.[args.ref];
  if(!expected||current?.[args.ref]!==expected)throw noInput('The observed screenshot changed at this canvas; observe again.');
 }

 private async fresh(binding:Binding){
  await binding.adapter.assertOwned();
  const state=await binding.adapter.driver.strictState();
  if(fingerprint(state)!==fingerprint(binding.state))throw noInput('Page document or geometry changed; observe again.');
 }
 async check(args:BoundAction,runId:string){
  const binding=this.binding(args,runId);
  if(this.journalUnavailable)throw noInput('Browser operation journal is invalid or unsafe; strict actions are unavailable.');
  if(!this.options.operationJournalPath)throw noInput('A durable browser operation journal is required.');
  if(this.active.has(this.key(binding)))throw noInput('This browser target is busy.');
  if((args.action==='drag'&&args.toRef===undefined||args.x!==undefined||args.y!==undefined)&&!binding.imageObserved)throw noInput('Observe a bound screenshot before canvas coordinates.');
  await this.host(binding);await this.fresh(binding);await this.visualFresh(binding,args);
  const target=await binding.adapter.driver.strictPrepare(args);
  const prior=this.plans.get(args);
  if(prior&&(prior.fingerprint!==fingerprint(args)||fingerprint(prior.target)!==fingerprint(target)))throw noInput('The approved action target changed.');
  this.plans.set(args,{binding,fingerprint:fingerprint(args),target});
 }
 private append(binding:Binding,operationId:string,phase:JournalRow['phase']){
  const path=this.options.operationJournalPath!;if(journalInfo(path)){const info=journalInfo(path)!;if(!info.isFile()||info.isSymbolicLink()||info.size>7_999_000){this.journalUnavailable=true;throw Error('Browser journal is unsafe or full.');}}mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const existed=existsSync(path),fd=openSync(path,constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{const row=Buffer.from(JSON.stringify({version:1,operationId,ownerId:binding.adapter.ownerId,targetId:binding.adapter.targetId,runId:binding.runId,phase,at:Date.now()})+'\n');let offset=0;while(offset<row.length){const written=writeSync(fd,row,offset);if(written<=0)throw Error('Incomplete browser journal write.');offset+=written;}fsyncSync(fd);}finally{closeSync(fd);}if(!existed){const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 }
 async act(args:BoundAction,ctx:{runId:string;signal:AbortSignal;assertToolActive?:()=>void}){
  if(this.journalUnavailable||!this.options.operationJournalPath)throw noInput('A valid durable browser journal is required.');
  const binding=this.binding(args,ctx.runId),key=this.key(binding);
  if(this.active.has(key))throw noInput('This browser target is busy.');
  const approved=this.plans.get(args);if(!approved||approved.fingerprint!==fingerprint(args))throw noInput('A checked exact action is required.');
  let settle!:()=>void;const done=new Promise<void>(r=>{settle=r;});this.active.set(key,{runId:ctx.runId,done});
  let dispatched=false;const operationId=randomUUID(),deadline=Date.now()+20_000;
  try{
   const before=await this.host(binding);await this.fresh(binding);await this.visualFresh(binding,args);
   const prepared=await binding.adapter.driver.strictPrepare(args);if(fingerprint(prepared)!==fingerprint(approved.target))throw noInput('The approved target changed.');
   const guard=async()=>{if(Date.now()>deadline)throw noInput('The bounded browser action deadline expired.');if(ctx.signal.aborted||this.closed.has(ctx.runId))throw noInput('The run was stopped.');ctx.assertToolActive?.();await this.fresh(binding);const freshTarget=await binding.adapter.driver.strictPrepare(args);if(fingerprint(freshTarget)!==fingerprint(approved.target))throw noInput('The approved target changed.');const host=await this.host(binding);if(fingerprint(host)!==fingerprint(before))throw noInput('Host focus or cursor changed.');};
   await guard();this.append(binding,operationId,'prepared');
   // Persist before the first possible input; any exception from here remains uncertain.
   this.append(binding,operationId,'dispatched');dispatched=true;binding.used=true;
   await binding.adapter.driver.strictPerform(args,approved.target,guard);
   const after=await this.host(binding);if(fingerprint(before)!==fingerprint(after))throw Error('Host focus or cursor changed after browser dispatch.');
   await binding.adapter.assertOwned();
   const state=await binding.adapter.driver.strictState();if(state.loaderId!==binding.state.loaderId||state.frameId!==binding.state.frameId||state.url!==binding.state.url)throw Error('The document changed during browser dispatch.');
   const readback=await binding.adapter.driver.strictReadback(args.ref);
   await binding.adapter.assertOwned();if(fingerprint(before)!==fingerprint(await this.host(binding)))throw Error('Host changed during readback.');
   const finalState=await binding.adapter.driver.strictState();if(finalState.loaderId!==state.loaderId||finalState.frameId!==state.frameId||finalState.url!==state.url)throw Error('Document changed during readback.');
   this.append(binding,operationId,'result');
   return {operationId,delivery:'delivered' as const,verification:'observed' as const,targetId:binding.adapter.targetId,readback};
  }catch(error){
   if(dispatched){this.blocked.add(key);try{this.append(binding,operationId,'unknown');}catch{/* The durable dispatched entry already blocks recovery. */}throw Object.assign(new Error('Browser delivery is uncertain; no repeat was sent. Inspect the exact target.'),{deliveryUnknown:true,retryable:false,cause:error});}
   throw error;
  }finally{this.active.delete(key);settle();}
 }
 async screenshot(bindingId:string,runId:string):Promise<Buffer> {
  const binding=this.bindings.get(bindingId);if(!binding||binding.runId!==runId||binding.used)throw noInput('Unknown or consumed observation.');
  await this.fresh(binding);if(!binding.adapter.driver.strictScreenshot)throw noInput('Bound screenshots are unavailable.');
  await binding.adapter.driver.strictScreenshot();const before=await binding.adapter.driver.strictVisualState?.();const image=await binding.adapter.driver.strictScreenshot();const after=await binding.adapter.driver.strictVisualState?.();await this.fresh(binding);if(fingerprint(before)!==fingerprint(after))throw noInput('Canvas content changed while its screenshot was observed.');binding.imageObserved=true;binding.visualState=after;return image;
 }
 preview(args:BoundAction){const binding=this.bindings.get(args.bindingId);if(!binding)throw noInput('Unknown browser binding.');const label=binding.refLines.get(args.ref)??'unavailable target';const destination=args.toRef===undefined?'':` → ${binding.refLines.get(args.toRef)??'unavailable target'}`;return `${binding.title.slice(0,128)} · ${new URL(binding.state.url).origin} · ${args.action}: ${label.slice(0,300)}${destination}`; }
 async dispose(){this.disposed=true;for(const binding of this.bindings.values())this.closed.add(binding.runId);for(const active of this.active.values())this.closed.add(active.runId);await Promise.all([...this.active.values()].map(op=>op.done));this.bindings.clear();}
 async releaseRun(runId:string){this.closed.add(runId);await Promise.all([...this.active.values()].filter(op=>op.runId===runId).map(op=>op.done));for(const [id,b]of this.bindings)if(b.runId===runId)this.bindings.delete(id);}
}
