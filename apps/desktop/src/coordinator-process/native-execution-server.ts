import {nativeExecutionRecord,nativeExecutionKeys,nativeExecutionOwner} from '../shared/native-execution.js';
import type {ObservationPort} from './server.js';
/** Parses replies only. It has no executable, spawn, write or dispatch payload capability. */
export function serveNativeExecution(port:ObservationPort):()=>void {
 let epoch='',closed=false,lastId=0,active:{id:number;owner:string;nativeEpoch?:string;buffer:string}|undefined;
 const post=(message:unknown)=>{if(!closed)port.postMessage(message);};
 port.on('message',({data:m})=>{
  if(closed||!nativeExecutionRecord(m))return;
  if(m.kind==='init'&&nativeExecutionKeys(m,['kind','epoch'])&&nativeExecutionOwner(m.epoch)&&!epoch){epoch=m.epoch;post({kind:'ready',epoch});return;}
  if(!epoch||m.epoch!==epoch)return;
  if(m.kind==='begin'&&nativeExecutionKeys(m,['kind','epoch','id','owner','op'])&&Number.isSafeInteger(m.id)&&(m.id as number)>lastId&&nativeExecutionOwner(m.owner)&&typeof m.op==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(m.op)&&!active){lastId=m.id as number;active={id:lastId,owner:m.owner,buffer:''};post({kind:'dispatch',epoch,id:lastId,owner:m.owner});return;}
  if(!active||m.id!==active.id||m.owner!==active.owner)return;
  if(m.kind==='cancel'&&nativeExecutionKeys(m,['kind','epoch','id','owner'])){active=undefined;return;}
  if(m.kind!=='data'||!nativeExecutionKeys(m,['kind','epoch','id','owner','nativeEpoch','text'])||!nativeExecutionOwner(m.nativeEpoch)||typeof m.text!=='string')return;
  if(active.nativeEpoch&&active.nativeEpoch!==m.nativeEpoch)return;active.nativeEpoch=m.nativeEpoch;active.buffer+=m.text;
  const result=(rest:Record<string,unknown>)=>{const saved=active!;active=undefined;post({kind:'result',epoch,id:saved.id,owner:saved.owner,nativeEpoch:saved.nativeEpoch,...rest});};
  if(active.buffer.length>16*1024*1024){result({ok:false,error:'Native reply exceeds protocol limit.'});return;}
  let newline:number;
  while(active&&(newline=active.buffer.indexOf('\n'))>=0){const line=active.buffer.slice(0,newline);active.buffer=active.buffer.slice(newline+1);if(!line.trim())continue;
   let reply:unknown;try{reply=JSON.parse(line);}catch{result({ok:false,error:'Malformed native reply.'});return;}
   if(!nativeExecutionRecord(reply)||reply.id!==active.id||typeof reply.ok!=='boolean'){result({ok:false,error:'Mismatched native reply.'});return;}
   if(reply.ok){result({ok:true,value:reply.result});return;}
   result({ok:false,error:typeof reply.error==='string'?reply.error:'Native action failed.',nativeRejection:true});return;
  }
 });
 return()=>{closed=true;active=undefined;};
}
