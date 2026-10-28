import {dragReasonCode,dragPhase,nativeDragDiagnostics,type DragReasonCode,type DragPhase} from './background-drag-diagnostics.js';
/** Transport receipts only. A native reply is not independent side-effect proof. */
import {validLeaseTarget,validOwner,type LeaseTarget} from './target-lease.js';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
export type OperationState='prepared'|'dispatched'|'native-result'|'unknown';
export interface OperationRecord {dispatchId:string;op:string;state:OperationState;createdAt:number;updatedAt:number;nativeStatus?:string;nativeReasonCode?:DragReasonCode;nativePhase?:DragPhase;nativeOperationId?:string;ownerRunId?:string;target?:LeaseTarget}
const operations=new Set(['scheduled_document_append','scheduled_document_save','background_press','background_set_value','background_open_document','background_save_document','background_document_move','background_scroll_position','background_menu_open','background_menu_select','background_drag']);
export class OperationJournal {
 private records:OperationRecord[]=[];
 private unavailable=false;
 constructor(private readonly path:string,private readonly capacity=512,private readonly assertCurrent?:()=>void){
  if(!isAbsolute(path)||!Number.isInteger(capacity)||capacity<1||capacity>512)throw Error('Invalid operation journal configuration.');
  this.reload();
 }
 private reload():void {
  const path=this.path,capacity=this.capacity;this.records=[];
  if(existsSync(path)){
   if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||lstatSync(path).size>512_000)throw Error('Unsafe operation journal path.');
   const data=JSON.parse(readFileSync(path,'utf8')) as {version?:number;records?:OperationRecord[]};
   if(data.version!==1||!Array.isArray(data.records)||data.records.length>capacity||data.records.some(r=>!r||typeof r.dispatchId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.dispatchId)||!operations.has(r.op)||!['prepared','dispatched','native-result','unknown'].includes(r.state)||!Number.isFinite(r.createdAt)||!Number.isFinite(r.updatedAt)||Object.keys(r).some(k=>!['dispatchId','op','state','createdAt','updatedAt','nativeStatus','nativeReasonCode','nativePhase','nativeOperationId','ownerRunId','target'].includes(k))||(r.nativeReasonCode!==undefined&&(!dragReasonCode(r.nativeReasonCode)||r.op!=='background_drag'))||(r.nativePhase!==undefined&&(!dragPhase(r.nativePhase)||r.op!=='background_drag'))||(r.ownerRunId!==undefined&&!validOwner(r.ownerRunId))||(r.target!==undefined&&(!r.ownerRunId||!validLeaseTarget(r.target)))||[r.nativeStatus,r.nativeOperationId].some(v=>v!==undefined&&(typeof v!=='string'||v.length>100)))||new Set(data.records.map(r=>r.dispatchId)).size!==data.records.length)throw Error('Invalid operation journal; background dispatch blocked.');
   this.records=data.records;

  }
 }
 quarantine():void {this.requireAdmission();this.reload();let changed=false;for(const r of this.records)if(r.state==='prepared'||r.state==='dispatched'){r.state='unknown';r.updatedAt=Date.now();changed=true;}if(changed)this.persist();}
 private requireAdmission():void {if(!this.assertCurrent)throw Error('Exclusive journal admission required.');this.assertCurrent();}
 unresolved():OperationRecord[]{this.reload();if(this.unavailable)throw Error('Operation journal persistence unavailable.');return structuredClone(this.records.filter(r=>r.state==='unknown'||r.state==='prepared'||r.state==='dispatched'));}
 prepare(op:string,metadata:{ownerRunId?:string;target?:LeaseTarget}={}):OperationRecord {
  this.requireAdmission();this.reload();
  if(metadata.ownerRunId!==undefined&&!validOwner(metadata.ownerRunId)||metadata.target!==undefined&&(!metadata.ownerRunId||!validLeaseTarget(metadata.target)))throw Error('Invalid journal owner/target identity.');
  if(this.unavailable)throw Error('Operation journal persistence unavailable; dispatch blocked.');
  if(!operations.has(op))throw Error('Unsupported journal operation.');
  if(this.records.length>=this.capacity){const i=this.records.findIndex(r=>r.state==='native-result');if(i<0)throw Error('Operation journal capacity reached; unresolved records preserved.');this.records.splice(i,1);}
  const r:OperationRecord={dispatchId:randomUUID(),op,state:'prepared',createdAt:Date.now(),updatedAt:Date.now(),...(metadata.ownerRunId?{ownerRunId:metadata.ownerRunId}:{}),...(metadata.target?{target:{...metadata.target}}:{})};this.records.push(r);this.persist();return structuredClone(r);
 }
 transition(id:string,state:OperationState,result?:unknown):void {
  this.requireAdmission();this.reload();
  if(this.unavailable)throw Error('Operation journal persistence unavailable; dispatch blocked.');
  const r=this.records.find(r=>r.dispatchId===id);if(!r)throw Error('Unknown dispatch ID.');
  if(r.state==='native-result'||r.state==='unknown')throw Error('Terminal dispatch cannot be reused.');
  if(r.state==='prepared'&&state!=='dispatched'&&state!=='unknown')throw Error('Invalid dispatch transition.');
  if(r.state==='dispatched'&&state!=='native-result'&&state!=='unknown')throw Error('Invalid dispatch transition.');
  r.state=state;r.updatedAt=Date.now();
  if(result&&typeof result==='object'){const x=result as Record<string,unknown>;if(r.op==='background_drag'){const d=nativeDragDiagnostics(x);if(d.reasonCode)r.nativeReasonCode=d.reasonCode;if(d.phase)r.nativePhase=d.phase;}if(typeof x.status==='string'&&x.status.length<=100)r.nativeStatus=x.status;if(typeof x.operationId==='string'&&x.operationId.length<=100)r.nativeOperationId=x.operationId;}
  this.persist();
 }
 query(id:string):OperationRecord|null {this.reload();if(this.unavailable)throw Error('Operation journal persistence unavailable.');const r=this.records.find(r=>r.dispatchId===id);return r?structuredClone(r):null;}
 private persist():void {
  this.requireAdmission();
  mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
  const temp=`${this.path}.${randomUUID()}.tmp`;let fd:number|undefined;
  try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify({version:1,records:this.records}));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,this.path);const dir=openSync(dirname(this.path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
  catch(error){this.unavailable=true;throw error;}
  finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
 }
}
