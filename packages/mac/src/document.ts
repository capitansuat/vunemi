import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {basename,isAbsolute,normalize} from 'node:path';
import type {DesktopEvidence,ToolContext,ToolDef} from '@vunemi/agent-core';
import {Helper} from './helper.js';
type Args={path:string;text:string};
type Observation={pid:number;bundleId:string;processStartedAt:number;windowId:number;windowTitle:string;documentPath:string;snapshotId:string;controlMode:string;status?:string;detail?:string;saveBackend?:string;operationId?:string;foregroundChanged?:boolean;cursorChanged?:boolean;deliveryUnknown?:boolean;targets:{ref:number;label:string;role:string;value?:string;backgroundActions:string[]}[]};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function file(path:string){
 if(typeof path!=='string'||!isAbsolute(path)||!path.endsWith('.txt')||path.includes('\0'))throw Error('An explicit absolute .txt document path is required.');
 const canonical=await realpath(path),info=await stat(canonical);
 // Existing UTF-8 plain text only. No format conversion, Save As or new file.
 if(!info.isFile()||info.size>64_000)throw Error('Only existing plain text documents up to 64 KB are supported.');
 const bytes=await readFile(canonical),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(text.includes('\0')||text.startsWith('{\\rtf'))throw Error('Only UTF-8 plain text is supported.');
 return {path:canonical,text,hash:hash(text),identity:`${info.dev}:${info.ino}`};
}
function field(o:Observation,path:string){
 const fields=o.targets?.filter(t=>t.role==='AXTextArea'&&t.backgroundActions.includes('set-value')&&typeof t.value==='string');
 if(o.controlMode!=='backgroundStrict'||o.bundleId!=='com.apple.TextEdit'||o.documentPath!==path||o.windowTitle!==basename(path)||!o.windowId||!o.processStartedAt||fields?.length!==1||o.foregroundChanged)throw Error('Exact background document identity is unavailable; no further input sent.');
 return fields[0]!;
}
function proof(o:Observation,path:string):DesktopEvidence{
 const f=field(o,path);return {version:1,kind:'observation',bundleId:o.bundleId,processStartedAt:o.processStartedAt,windowId:o.windowId,windowTitle:o.windowTitle,fieldRef:f.ref,documentPath:path,valueHash:hash(f.value!)};
}
export function backgroundDocumentTool(helper:Helper,ensurePermission:()=>Promise<void>):ToolDef<Args>{
 const scopes=new WeakMap<object,string>(),identities=new WeakMap<object,string>();
 return {name:'desktop_background_document',description:'Open an existing UTF-8 .txt in TextEdit without activation, append exact text once, save through TextEdit and independently verify disk and field. One approval covers this bounded operation. Requires the absolute path and quoted append text in the user request. No keyboard, pointer, clipboard or focus fallback.',
 parameters:{type:'object',properties:{path:{type:'string'},text:{type:'string',maxLength:2000}},required:['path','text']},actionClass:'outbound',onDemand:'desktop',alwaysAsk:true,
 async check(args){scopes.delete(args);identities.delete(args);const f=await file(args.path);if(typeof args.text!=='string'||!args.text||args.text.length>2000)throw Error('A bounded nonempty append is required.');scopes.set(args,`mac-background-document:com.apple.TextEdit:${f.path}`);identities.set(args,f.identity);return null;},
 async preview(args){return `TextEdit: open without changing focus, append and save ${args.path}\n${args.text}`;},
 async run(args,ctx){
  // Authority comes from the human goal, never document contents or model paths.
  const goal=ctx.userGoal??'';
  const normalized=normalize(args.path);
  if(!goal.includes(args.path)||!goal.includes(args.text)||!/TextEdit/i.test(goal)||!/kaydet|save/iu.test(goal))throw Error('Document path and append text must match the explicit user request scope.');
  const original=await file(normalized);
  const currentScope=`mac-background-document:com.apple.TextEdit:${original.path}`;
  if(scopes.has(args)&&(scopes.get(args)!==currentScope||identities.get(args)!==original.identity))throw Error('Document identity changed while approval was pending. No input sent.');
  const state=ctx.desktopDocumentState?.()??{receipts:[],uncertain:false};
  if(state.uncertain)throw Error('Prior delivery is uncertain; no repeat sent. Inspect the document.');
  const prior=state.receipts.findLast(e=>e.kind==='verified-append'&&e.documentPath===original.path&&e.appendedText===args.text);
  const active=()=>{if(ctx.signal.aborted)throw Error('Stopped; existing work preserved.');ctx.assertToolActive?.();};
  let leaseTarget:import('./target-lease.js').LeaseTarget|undefined;
  const rpc=async(op:string,payload:Record<string,unknown>,effect=false)=>{
   active();await ensurePermission();active();
   try{const result=await helper.call(op,payload,{signal:ctx.signal,assertActive:ctx.assertToolActive,timeoutMs:op==='background_save_document'?60_000:20_000,ownerRunId:ctx.runId,...(op!=='background_open_document'&&leaseTarget?{target:leaseTarget}:{})}) as Observation;
    if(result.deliveryUnknown===true||result.cursorChanged===true||result.foregroundChanged===true)throw Object.assign(Error(`Background document delivery is uncertain (${String((result as {reasonCode?:unknown}).reasonCode??result.status??'unknown')}); no further input sent.`),{deliveryUnknown:true,noInputSent:false});
    if(typeof result.documentPath==='string')result.documentPath=await realpath(result.documentPath);
    return result;}
   catch(e){if(effect&&!(e instanceof Error&&(('noInputSent' in e&&e.noInputSent===true)||('nativeRejection' in e&&e.nativeRejection===true))))throw Object.assign(e instanceof Error?e:Error(String(e)),{deliveryUnknown:true});throw e;}
  };
  let observed=await rpc('background_open_document',{path:original.path});
  const record=(e:DesktopEvidence)=>ctx.recordDesktopEvidence?.({...e,requestedPath:args.path});
  let f=field(observed,original.path),p=proof(observed,original.path);leaseTarget={bundleId:observed.bundleId,pid:observed.pid,processStartedAt:observed.processStartedAt,windowId:observed.windowId};record(p);active();
  if(prior){
   if(p.valueHash!==prior.valueHash||![prior.diskBeforeHash,prior.valueHash].includes(original.hash))throw Error('The document or disk changed after interruption. No append repeated and no save sent.');
  }else{
   if(f.value!.length+args.text.length>2000)throw Error('Background document replacement is limited to 2000 characters. No input sent.');
   const before=f.value!,next=before+args.text;
   active();await ctx.recordDesktopAppendIntent?.();active();
   try {
    observed=await rpc('background_set_value',{app:String(observed.pid),snapshotId:observed.snapshotId,ref:f.ref,label:f.label,expectedValue:before,text:next},true);
    f=field(observed,original.path);p=proof(observed,original.path);
    if(observed.status!=='verified'||!observed.operationId||f.value!==next)throw Error('Native append delivery is uncertain; no repeat sent.');
    record({...p,kind:'verified-append',beforeHash:hash(before),diskBeforeHash:original.hash,appendedText:args.text,operationId:observed.operationId});
   }catch(error){
    if(error instanceof Error&&(('noInputSent' in error&&error.noInputSent===true)||('nativeRejection' in error&&error.nativeRejection===true)))throw error;
    throw Object.assign(error instanceof Error?error:Error(String(error)),{deliveryUnknown:true});
   }
  }
  active();
  const expected=f.value!;
  const saved=await rpc('background_save_document',{app:String(observed.pid),path:original.path,snapshotId:observed.snapshotId,ref:f.ref,label:f.label,expectedValue:expected,expectedDiskHash:original.hash},true);
  if(saved.status!=='saved')throw Object.assign(Error(`TextEdit save is not verified: ${saved.detail??JSON.stringify({status:saved.status,documentPath:saved.documentPath,foregroundChanged:saved.foregroundChanged})}`),{deliveryUnknown:true});
  const savedProof=proof(saved,original.path),savedField=field(saved,original.path);
  const disk=await file(original.path);active();
  if(saved.status!=='saved'||!saved.operationId||savedField.value!==expected||disk.text!==expected)throw Error('The saved disk contents do not match the verified field; save is not certified.');
  record({...savedProof,kind:'verified-save',diskHash:disk.hash,operationId:saved.operationId});
  ctx.produced?.({kind:'file',path:original.path});
  return JSON.stringify({status:'saved-and-verified',path:original.path,appendRepeated:false,saveBackend:saved.saveBackend,valueHash:disk.hash,foregroundChanged:saved.foregroundChanged??false});
 }};
}
