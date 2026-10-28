import type {HostObservation} from '@vunemi/browser';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** The native timestamp is Unix seconds; no model or renderer supplies this probe. */
export function browserHostObservation(value:unknown):HostObservation {
 const cursor=object(value)?value.cursor:undefined;
 if(!object(value)||value.version!==1||value.verified!==true||value.unlocked!==true||!Number.isSafeInteger(value.foregroundPid)||Number(value.foregroundPid)<=0||typeof value.observedAt!=='number'||!Number.isFinite(value.observedAt)||Date.now()/1000-value.observedAt>10||value.observedAt-Date.now()/1000>1||!object(cursor)||typeof cursor.x!=='number'||!Number.isFinite(cursor.x)||typeof cursor.y!=='number'||!Number.isFinite(cursor.y))
  throw Object.assign(new Error('A fresh verified unlocked host observation is required. No input sent.'),{noInputSent:true,retryable:false});
 return {foregroundPid:Number(value.foregroundPid),cursor:{x:cursor.x,y:cursor.y},unlocked:true};
}
