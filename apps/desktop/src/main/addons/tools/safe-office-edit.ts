/**
 * Opt-in, snapshot-bound Office replacement. Existing outputs stay new-only by default.
 * The original is kept in Vunemi's own folder, not beside the file: a copy named
 * "report.before-edit-….xlsx" next to the result read as a second, different file.
 * The change is offered for undo, which puts the original back.
 */
import {createHash,randomUUID} from 'node:crypto';
import {constants,copyFileSync,existsSync,mkdirSync,openSync,closeSync,readFileSync,fstatSync,lstatSync,fsyncSync,renameSync,unlinkSync,chmodSync} from 'node:fs';
import {dirname,extname,join,basename} from 'node:path';
import type {Roots} from '@vunemi/files';
import type {ToolContext} from '@vunemi/agent-core';
import {t} from '@vunemi/i18n';
import {deliver} from './common.js';
type Snapshot={hash:string;dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number;mode:number};
export interface OfficeEditPlan {readonly path:string;readonly input:string;readonly backupPath?:string;readonly snapshot?:Snapshot}
function snapshot(path:string):Snapshot {
 if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('Office replacement requires a regular file.');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=fstatSync(fd);if(before.size>64_000_000)throw Error('Office replacement is limited to 64 MB.');const hash=createHash('sha256').update(readFileSync(fd)).digest('hex'),after=fstatSync(fd);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Office target changed during observation.');return {hash,dev:after.dev,ino:after.ino,size:after.size,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs,mode:after.mode};}finally{closeSync(fd);}
}
export function createSafeOfficeEdits(roots:Roots,backupDir:string){
 const prepared=new WeakMap<object,Map<string,OfficeEditPlan>>();
 const verify=(plan:OfficeEditPlan)=>{
  if(roots.resolve(plan.input,'write')!==plan.path)throw Error('Office target path changed; no replacement sent.');
  if(plan.snapshot){if(JSON.stringify(snapshot(plan.path))!==JSON.stringify(plan.snapshot))throw Error('Office target changed after approval snapshot; replacement refused.');if(dirname(plan.backupPath!)!==backupDir||existsSync(plan.backupPath!))throw Error('Office backup destination already exists.');}
  else if(existsSync(plan.path))throw Error('Output destination already exists.');
 };
 return {
  prepare(args:object,input:string,replaceExisting:unknown=false):OfficeEditPlan {
   if(replaceExisting!==undefined&&typeof replaceExisting!=='boolean')throw Error('replaceExisting must be boolean.');
   const key=`${input}:${replaceExisting===true}`,prior=prepared.get(args)?.get(key);if(prior){verify(prior);return prior;}
   const path=roots.resolve(input,'write');
   if(replaceExisting===true&&!/\.(docx|xlsx|pptx)$/i.test(path))throw Error('Replacement is supported only for Office DOCX/XLSX/PPTX files.');
   if(replaceExisting!==true&&existsSync(path))throw Error('Output destination already exists. Use explicit replaceExisting only for a reviewed Office edit.');
   if(replaceExisting===true&&!existsSync(path))throw Error('replaceExisting requires an existing Office target.');
   const state=replaceExisting===true?snapshot(path):undefined;
   const backupPath=state?join(backupDir,`${basename(path,extname(path))}.before-edit-${randomUUID()}${extname(path)}`):undefined;
   const plan=Object.freeze({path,input,...(state?{snapshot:Object.freeze(state),backupPath}: {})});
   const map=prepared.get(args)??new Map<string,OfficeEditPlan>();map.set(key,plan);prepared.set(args,map);return plan;
  },verify,
  deliver(made:string,plan:OfficeEditPlan,ctx:ToolContext):void {
   const active=()=>{ctx.signal.throwIfAborted();ctx.assertToolActive?.();};active();verify(plan);
   if(!plan.snapshot){deliver(made,plan.path,ctx);return;}
   if(!lstatSync(made).isFile()||lstatSync(made).isSymbolicLink()||lstatSync(made).size===0)throw Error('Engine Office output must be a nonempty regular file.');
   const stage=join(dirname(plan.path),`${basename(plan.path)}.edit-${randomUUID()}.tmp`);
   let committed=false;
   try{
    roots.resolve(stage,'write');copyFileSync(made,stage,constants.COPYFILE_EXCL);chmodSync(stage,plan.snapshot.mode&0o777);const staged=openSync(stage,'r');try{fsyncSync(staged);}finally{closeSync(staged);}
    active();verify(plan);
    mkdirSync(backupDir,{recursive:true,mode:0o700});copyFileSync(plan.path,plan.backupPath!,constants.COPYFILE_EXCL);chmodSync(plan.backupPath!,0o600);const backup=openSync(plan.backupPath!,'r');try{fsyncSync(backup);}finally{closeSync(backup);}
    const backupDirectory=openSync(backupDir,'r');try{fsyncSync(backupDirectory);}finally{closeSync(backupDirectory);}
    if(snapshot(plan.backupPath!).hash!==plan.snapshot.hash)throw Error('Office backup differs from approved original; replacement refused.');
    active();if(roots.resolve(plan.input,'write')!==plan.path||JSON.stringify(snapshot(plan.path))!==JSON.stringify(plan.snapshot))throw Error('Office target changed before commit; original preserved.');
    // Atomic publication, but Node has no filesystem compare-and-swap against external writers.
    renameSync(stage,plan.path);committed=true;const original=plan.backupPath!;ctx.offerUndo(t('files.undo.restore',{name:basename(plan.path)}),async()=>{copyFileSync(original,plan.path);});ctx.produced?.({kind:'file',path:plan.path});const directory=openSync(dirname(plan.path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
   }catch(error){if(committed)throw Object.assign(error instanceof Error?error:Error(String(error)),{deliveryUnknown:true,backupPath:plan.backupPath});throw error;}finally{if(existsSync(stage))unlinkSync(stage);}
  }
 };
}
