import {isLocale,setLocale} from '@vunemi/i18n';
import {isNativeObservationRequest,type NativeObservationInvoke} from '../shared/native-observation.js';
export interface ObservationPort {postMessage(message:unknown):void;on(event:'message',handler:(event:{data:unknown})=>void):unknown}
export interface ObservationHelper {call(op:string,args:Record<string,unknown>,opts:{signal:AbortSignal;timeoutMs:number;ownerRunId:string}):Promise<unknown>;dispose():void}
/** The process channel never receives permissions or a general tool dispatcher. */
export function serveNativeObservations(port:ObservationPort,create:(binary:string)=>ObservationHelper):()=>void{
 let epoch:string|undefined,helper:ObservationHelper|undefined,active:{request:NativeObservationInvoke;abort:AbortController}|undefined,closed=false;
 const seen=new Set<number>();
 const post=(value:unknown)=>{if(!closed)port.postMessage(value);};
 const reply=(request:NativeObservationInvoke,rest:Record<string,unknown>)=>post({kind:'reply',epoch,id:request.id,owner:request.owner,...rest});
 port.on('message',({data})=>{
  if(closed||!data||typeof data!=='object'||Array.isArray(data))return;
  const m=data as Record<string,unknown>;
  if(m.kind==='init'){
   if(epoch||Object.keys(m).sort().join(',')!=='epoch,helperPath,kind,locale'||typeof m.epoch!=='string'||m.epoch.length>256||!m.epoch||typeof m.helperPath!=='string'||!m.helperPath.startsWith('/')||m.helperPath.includes('\0')||typeof m.locale!=='string'||!isLocale(m.locale))return;
   epoch=m.epoch;setLocale(m.locale);helper=create(m.helperPath);post({kind:'ready',epoch});return;
  }
  if(!epoch||!helper||m.epoch!==epoch)return;
  if(m.kind==='cancel'){
   if(Object.keys(m).sort().join(',')==='epoch,id,kind,owner'&&active&&m.id===active.request.id&&m.owner===active.request.owner)active.abort.abort(new Error('Observation stopped.'));
   return;
  }
  if(m.kind!=='invoke'||Object.keys(m).sort().join(',')!=='args,epoch,id,kind,op,owner,timeoutMs'||!Number.isSafeInteger(m.id)||(m.id as number)<1||typeof m.owner!=='string'||!m.owner||m.owner.length>256||typeof m.timeoutMs!=='number'||!Number.isFinite(m.timeoutMs)||m.timeoutMs<1||m.timeoutMs>150000)return;
  const request=m as unknown as NativeObservationInvoke;
  if(!isNativeObservationRequest(m.op,m.args)){reply(request,{ok:false,error:'Unsupported observation request.'});return;}
  if(active||seen.has(request.id)){reply(request,{ok:false,error:'Observation coordinator busy or request already used.'});return;}
  // Bound memory without forgetting an accepted request: a new epoch is needed at the cap.
  if(seen.size>=10000){reply(request,{ok:false,error:'Observation coordinator request limit reached.'});return;}
  seen.add(request.id);const abort=new AbortController();active={request,abort};
  const complete=(result:Record<string,unknown>)=>{if(active?.request===request)active=undefined;reply(request,result);};
  void helper.call(request.op,request.args,{signal:abort.signal,timeoutMs:request.timeoutMs,ownerRunId:request.owner}).then(value=>{
   if(abort.signal.aborted)complete({ok:false,error:'Observation stopped.'});else complete({ok:true,value});
  },error=>complete({ok:false,error:error instanceof Error?error.message:'Observation failed.',...(error&&typeof error==='object'&&(error as {nativeRejection?:boolean}).nativeRejection===true?{nativeRejection:true}:{})}));
 });
 return()=>{closed=true;active?.abort.abort(new Error('Observation coordinator disconnected.'));helper?.dispose();};
}
