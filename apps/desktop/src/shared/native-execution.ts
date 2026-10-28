/** Private main↔native coordinator messages. Main owns every executable and dispatch payload. */
export type NativeExecutionToWorker=
 |{kind:'init';epoch:string}
 |{kind:'begin';epoch:string;id:number;owner:string;op:string}
 |{kind:'data';epoch:string;id:number;owner:string;nativeEpoch:string;text:string}
 |{kind:'cancel';epoch:string;id:number;owner:string};
export type NativeExecutionFromWorker=
 |{kind:'ready';epoch:string}
 |{kind:'dispatch';epoch:string;id:number;owner:string}
 |{kind:'result';epoch:string;id:number;owner:string;nativeEpoch:string;ok:boolean;value?:unknown;error?:string;nativeRejection?:boolean};
export function nativeExecutionRecord(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>'value'in d);}
export const nativeExecutionKeys=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).sort().join(',')===keys.sort().join(',');
export const nativeExecutionOwner=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/u.test(value);
