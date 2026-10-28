import type {QuotedSource} from '@vunemi/agent-core';
import type {MenuItem} from '../components/MentionMenu.js';
export interface ComposerDraft {text:string;files:string[];mentions:MenuItem[];quote?:QuotedSource}
const EMPTY:ComposerDraft={text:'',files:[],mentions:[]};
/** Renderer memory only: changing conversations never submits or discards a draft. */
export class ComposerDrafts {
 private drafts=new Map<string,ComposerDraft>();
 private listeners=new Set<()=>void>();
 read=(sessionId:string):ComposerDraft=>this.drafts.get(sessionId)??EMPTY;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 change<K extends keyof ComposerDraft>(sessionId:string,key:K,value:ComposerDraft[K]|((current:ComposerDraft[K])=>ComposerDraft[K])){const current=this.read(sessionId),next=typeof value==='function'?value(current[key]):value;this.drafts.set(sessionId,{...current,[key]:next});this.listeners.forEach(fn=>fn());}
 clearIf(sessionId:string,submitted:ComposerDraft):boolean{if(this.read(sessionId)!==submitted)return false;this.drafts.delete(sessionId);this.listeners.forEach(fn=>fn());return true;}
}
export const composerDrafts=new ComposerDrafts();
