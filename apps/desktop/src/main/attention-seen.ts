import {chmodSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {AttentionItem,AttentionSnapshot} from '../shared/ipc.js';
/** Reviews older than this leave the list by themselves. Only reviews: waiting work and uncertain results stay until the user removes them. */
export const REVIEW_DAYS=7;
const DAY=86_400_000;
const key=(item:{sessionId:string;taskId:string}):string=>`${item.sessionId}\u0000${item.taskId}`;
/**
 * Tasks the user took off the Needs attention list. Display only: no task
 * record, operation or journal entry is changed, so an uncertain result stays
 * uncertain and is never repeated or called done. Each entry keeps the task's
 * time, so a task comes back when anything happens in it again.
 */
export class AttentionSeen{
 private readonly seen:Map<string,number>;
 constructor(private readonly file:string){this.seen=this.load();}
 private load():Map<string,number>{
  try{
   const raw=JSON.parse(readFileSync(this.file,'utf8')) as {version?:unknown;seen?:unknown};
   if(raw.version!==1||!Array.isArray(raw.seen))return new Map();
   return new Map((raw.seen as unknown[]).filter((e):e is [string,number]=>Array.isArray(e)&&typeof e[0]==='string'&&Number.isSafeInteger(e[1])));
  }catch{return new Map();}
 }
 private save():void{
  mkdirSync(dirname(this.file),{recursive:true});
  const tmp=`${this.file}.tmp`;
  writeFileSync(tmp,JSON.stringify({version:1,seen:[...this.seen]}),{mode:0o600});
  chmodSync(tmp,0o600);
  renameSync(tmp,this.file);
 }
 shown(item:AttentionItem,now:number):boolean{
  if(this.seen.get(key(item))===item.updatedAt)return false;
  return !(item.reason==='review'&&now-item.updatedAt>REVIEW_DAYS*DAY);
 }
 /** Takes `items` off the list. Entries for tasks that no longer need attention, or changed since, are forgotten. */
 dismiss(items:readonly AttentionItem[],all:readonly AttentionItem[]):void{
  for(const item of items)this.seen.set(key(item),item.updatedAt);
  const live=new Map(all.map(item=>[key(item),item.updatedAt]));
  for(const [k,at] of this.seen)if(live.get(k)!==at)this.seen.delete(k);
  this.save();
 }
}
/** The listed tasks a request names, matched on session, task and time; anything else is refused. */
export function requireAttentionDismissal(snapshot:AttentionSnapshot,raw:unknown):AttentionItem[]{
 const list=(raw as {items?:unknown}|null)?.items;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).join()!=='items'||!Array.isArray(list)||list.length===0||list.length>500)throw Error('Invalid attention dismissal.');
 return list.map(entry=>{
  const x=entry as Record<string,unknown>|null;
  const found=x&&typeof x==='object'&&typeof x.sessionId==='string'&&typeof x.taskId==='string'&&Number.isSafeInteger(x.updatedAt)?snapshot.items.find(i=>i.sessionId===x.sessionId&&i.taskId===x.taskId&&i.updatedAt===x.updatedAt):undefined;
  if(!found)throw Error('This task no longer needs attention.');
  return found;
 });
}
