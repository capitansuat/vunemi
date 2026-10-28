import {validDesktopEvidence,type DesktopEvidence} from '@vunemi/agent-core';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import type {Helper} from './helper.js';
import type {NativeRecipeBinding,NativeRecipeExecutionContext,NativeRecipeSlotResult} from './native-recipe-types.js';
export type {NativeRecipeBinding,NativeRecipeExecutionContext,NativeRecipeSlotResult} from './native-recipe-types.js';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const equal=isDeepStrictEqual;
type Options={helper:Helper;assertPath:(p:string,access:'read'|'write')=>string;helperRevision:()=>string};
export class NativeRecipeDriver {
 constructor(private readonly options:Options){}
 private active(c:NativeRecipeExecutionContext){if(c.signal.aborted)throw Error('stopped');c.assertActive();}
 private async file(path:string){
  if(!isAbsolute(path)||!path.endsWith('.txt')||await realpath(path)!==path||this.options.assertPath(path,'write')!==path)throw Error('invalid-path');
  const parent=await lstat(dirname(path),{bigint:true}),s=await lstat(path,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.size>8000n||!parent.isDirectory()||parent.isSymbolicLink())throw Error('invalid-file');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
   const anchor=await fd.stat({bigint:true});if(!anchor.isFile()||anchor.dev!==s.dev||anchor.ino!==s.ino||anchor.size!==s.size)throw Error('file-drift');
   const bytes=await fd.readFile();if(bytes.length>8000)throw Error('file-too-large');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   const end=await fd.stat({bigint:true}),p=await lstat(path,{bigint:true}),par=await lstat(dirname(path),{bigint:true});
   if(await realpath(path)!==path||p.ino!==s.ino||p.dev!==s.dev||!p.isFile()||end.ino!==s.ino||end.size!==s.size||end.mtimeNs!==s.mtimeNs||end.ctimeNs!==s.ctimeNs||par.ino!==parent.ino||par.dev!==parent.dev||text.length>2000||text.includes('\0')||text.startsWith('{\\rtf'))throw Error('file-drift');
   return {bytes,text,version:{device:String(s.dev),inode:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),sha256:hash(bytes)},parentDevice:String(parent.dev),parentInode:String(parent.ino)};
  }finally{await fd.close();}
 }
 private literal(text:string){if(typeof text!=='string'||!text.length||text.length>256||text.includes('\0'))throw Error('invalid-literal');}
 async targets():Promise<{path:string;pid:number;windowId:number;title:string}[]>{
  const r=await this.options.helper.call('scheduled_recipe_targets') as {targets:unknown[]};if(!Array.isArray(r.targets)||r.targets.length>128)throw Error('invalid-targets');
  return r.targets.flatMap((x:any)=>{try{if(typeof x.path!=='string'||this.options.assertPath(x.path,'write')!==x.path||!Number.isSafeInteger(x.pid)||x.pid<=0||!Number.isSafeInteger(x.windowId)||x.windowId<=0||typeof x.title!=='string')return [];return [{path:x.path,pid:x.pid,windowId:x.windowId,title:x.title.slice(0,4096)}];}catch{return [];}});
 }
 async prepare(target:{path:string;pid:number;windowId:number},literal:string,c:NativeRecipeExecutionContext):Promise<NativeRecipeBinding>{
  this.literal(literal);this.active(c);const f=await this.file(target.path);if(f.text.length+literal.length>2000)throw Error('document-limit');
  const r=await this.options.helper.call('scheduled_recipe_prepare',{app:String(target.pid),path:target.path,windowId:target.windowId,literal},{signal:c.signal,assertActive:()=>this.active(c)}) as {binding:NativeRecipeBinding};this.active(c);
  if(!r.binding||r.binding.helperRevision!==this.options.helperRevision()||r.binding.target.path!==target.path||r.binding.target.pid!==target.pid||r.binding.target.windowId!==target.windowId||r.binding.target.parentDevice!==f.parentDevice||r.binding.target.parentInode!==f.parentInode||!equal(r.binding.version,f.version)||r.binding.textUnits!==f.text.length)throw Error('binding-drift');return structuredClone(r.binding);
 }
 async revalidate(binding:NativeRecipeBinding,c:NativeRecipeExecutionContext):Promise<boolean>{try{return equal(await this.prepare(binding.target,'\n',c),binding);}catch{return false;}}
 async execute(binding:NativeRecipeBinding,literal:string,backupPath:string,c:NativeRecipeExecutionContext):Promise<NativeRecipeSlotResult>{
  let backup:{path:string;sha256:string}|undefined,mayHaveInput=false,uncertainBackup=false;const dispatchIds:string[]=[];
  try{
   this.literal(literal);this.active(c);const before=await this.file(binding.target.path);
   if(!equal(before.version,binding.version)||before.parentDevice!==binding.target.parentDevice||before.parentInode!==binding.target.parentInode||binding.helperRevision!==this.options.helperRevision())throw Error('target-drift');
   const deadline=Math.min(c.expiresAt??Infinity,Date.now()+30_000);if(!Number.isFinite(deadline)||deadline<=Date.now())throw Error('expired');
   const payload={app:String(binding.target.pid),path:binding.target.path,windowId:binding.target.windowId,literal,binding,runtime:true,backupPath,deadline:deadline/1000};
   const prep=await this.options.helper.call('scheduled_recipe_prepare',payload,{signal:c.signal,assertActive:()=>this.active(c)}) as {binding:NativeRecipeBinding;handle:string;status?:string;reasonCode?:string};this.active(c);if(prep.status==='no-input')throw Error(prep.reasonCode??'target-drift');if(!equal(prep.binding,binding)||typeof prep.handle!=='string')throw Error('target-drift');
   if(dirname(backupPath)!==dirname(binding.target.path)||!backupPath.startsWith(binding.target.path+'.vunemi-before-scheduled-')||this.options.assertPath(backupPath,'write')!==backupPath)throw Error('backup-path');
   uncertainBackup=true;
   const copied=await this.options.helper.call('scheduled_recipe_backup',{app:String(binding.target.pid),handle:prep.handle,deadline:deadline/1000},{signal:c.signal,assertActive:()=>this.active(c),ownerRunId:c.runId,target:{bundleId:binding.target.bundleId,pid:binding.target.pid,windowId:binding.target.windowId,processStartedAt:Number(binding.target.startSec)+Number(binding.target.startUsec)/1e6}}) as {status:string;backupCreated?:boolean;path?:string;sha256?:string};
   uncertainBackup=false;
   if(copied.backupCreated===true&&copied.path===backupPath)backup={path:backupPath,sha256:copied.sha256??''};
   if(copied.status!=='backup-created'||!backup||backup.sha256!==before.version.sha256)throw Error('backup-unverified');
   const checkedParent=await lstat(dirname(backupPath),{bigint:true});if(String(checkedParent.dev)!==binding.target.parentDevice||String(checkedParent.ino)!==binding.target.parentInode||await realpath(dirname(backupPath))!==dirname(backupPath))throw Error('backup-parent-drift');
   const check=await open(backupPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const saved=await check.readFile();if(hash(saved)!==before.version.sha256)throw Error('backup-invalid');}finally{await check.close();}
   c.recordBackup(backup.path,backup.sha256);this.active(c);
   if(!equal((await this.file(binding.target.path)).version,binding.version))throw Error('target-drift');
   const target={bundleId:binding.target.bundleId,pid:binding.target.pid,windowId:binding.target.windowId,processStartedAt:Number(binding.target.startSec)+Number(binding.target.startUsec)/1e6};
   const call=async(phase:'append'|'save',handle:string)=>{
    this.active(c);if(Date.now()>=deadline)throw Error('deadline');
    try{return await this.options.helper.call(phase==='append'?'scheduled_document_append':'scheduled_document_save',{app:String(target.pid),handle,deadline:deadline/1000},{signal:c.signal,assertActive:()=>this.active(c),ownerRunId:c.runId,target,timeoutMs:Math.max(1,Math.min(20_000,deadline-Date.now())),beforeDispatch:id=>{this.active(c);c.beforeChild(phase,id);dispatchIds.push(id);mayHaveInput=true;}}) as any;}
    catch(e){if((e as any)?.noInputSent!==true)mayHaveInput=true;throw e;}
   };
   const appended=await call('append',prep.handle);if(appended.status==='rejected'&&appended.noInputSent===true){mayHaveInput=false;return{status:'backup-only',backup,dispatchIds,noInputSent:true,reasonCode:'native-precondition'};}if(appended.status!=='verified'||appended.deliveryUnknown||appended.afterHash!==hash(Buffer.from(before.text+literal,'utf8'))||typeof appended.saveHandle!=='string')throw Error('append-unknown');
   this.active(c);const saved=await call('save',appended.saveHandle);if(saved.status!=='verified'||saved.deliveryUnknown||!saved.binding)throw Error('save-unknown');
   this.active(c);const after=await this.file(binding.target.path),b=saved.binding as NativeRecipeBinding;
   if(after.text!==before.text+literal||!equal(b.version,after.version)||!equal(b.target,binding.target)||b.uid!==binding.uid||b.securitySessionId!==binding.securitySessionId||b.helperRevision!==binding.helperRevision||b.textUnits!==after.text.length)throw Error('verification-unknown');
   const evidence=saved.evidence as DesktopEvidence;if(!validDesktopEvidence(evidence)||evidence.kind!=='verified-save'||evidence.documentPath!==binding.target.path||evidence.valueHash!==after.version.sha256||evidence.diskHash!==after.version.sha256)throw Error('receipt-invalid');
   const append:DesktopEvidence={...evidence,kind:'verified-append',operationId:appended.operationId,beforeHash:before.version.sha256,diskBeforeHash:before.version.sha256,appendedText:literal};
   return {status:'verified',afterBinding:b,backup,dispatchIds,receipts:[append,evidence]};
  }catch(error){if((error as any)?.noInputSent===true)uncertainBackup=false;if(mayHaveInput||uncertainBackup)this.options.helper.blockTarget?.(c.runId,{bundleId:binding.target.bundleId,pid:binding.target.pid,windowId:binding.target.windowId,processStartedAt:Number(binding.target.startSec)+Number(binding.target.startUsec)/1e6});return {status:mayHaveInput||uncertainBackup?'unknown':backup?'backup-only':'no-input',...(backup?{backup}:{}),dispatchIds,reasonCode:error instanceof Error?error.message:'recipe-failed'};}
 }
}
