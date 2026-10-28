import type {ToolDef,TaskPermissionDescriptor} from '@vunemi/agent-core';
import type {Helper} from './helper.js';
const identities=new WeakMap<object,{app:string;windowId:number;identity:Extract<TaskPermissionDescriptor,{effect:'window-observe'}>['identity']}>();
export function preparedWindowReadIdentity(args:{app:string;windowId?:number}):Extract<TaskPermissionDescriptor,{effect:'window-observe'}>['identity']|undefined {
 const prepared=identities.get(args);if(!prepared)return;
 if(prepared.app!==args.app||prepared.windowId!==args.windowId)throw new Error('Prepared window arguments changed.');
 return structuredClone(prepared.identity);
}
export function createWindowReadPermission(helper:Helper):NonNullable<ToolDef<{app:string;windowId?:number}>['taskPermission']>{
 const prepared=new WeakMap<object,{app:string;windowId:number;descriptor:TaskPermissionDescriptor}>();
 async function metadata(args:{app:string;windowId?:number},context:Parameters<NonNullable<ToolDef['taskPermission']>['prepare']>[1]):Promise<TaskPermissionDescriptor|null>{
  context.assertToolActive();if(!/^[1-9]\d*$/.test(args.app)||!Number.isSafeInteger(args.windowId)||args.windowId!<=0)return null;
  const v=await helper.call('background_target_identity',{app:args.app,windowId:args.windowId},{signal:context.signal,assertActive:context.assertToolActive}) as Record<string,unknown>;
  if(v.version!==1||v.controlMode!=='backgroundStrict'||v.pid!==Number(args.app)||v.windowId!==args.windowId||typeof v.bundleId!=='string'||!v.bundleId||typeof v.appName!=='string'||typeof v.windowTitle!=='string'||typeof v.startSec!=='string'||typeof v.startUsec!=='string'||!/^\d+$/.test(v.startSec)||!/^\d+$/.test(v.startUsec)||JSON.stringify(v).length>20480)return null;
  return {effect:'window-observe',target:{kind:'native-window',bundleId:v.bundleId,appName:v.appName,pid:v.pid as number,windowId:v.windowId as number,windowTitle:v.windowTitle},identity:{kind:'native-window',bundleId:v.bundleId,pid:v.pid as number,windowId:v.windowId as number,startSec:v.startSec,startUsec:v.startUsec,controlMode:'backgroundStrict'}};
 }
 return {async prepare(args,context){try{const d=await metadata(args,context);if(d){prepared.set(args,{app:args.app,windowId:args.windowId!,descriptor:structuredClone(d)});if(d.effect==='window-observe')identities.set(args,{app:args.app,windowId:args.windowId!,identity:structuredClone(d.identity)});}return d;}catch{return null;}},async revalidate(args,d,context){try{const old=prepared.get(args);if(!old||args.app!==old.app||args.windowId!==old.windowId)return false;const fresh=await metadata(args,context);return !!fresh&&JSON.stringify(fresh.identity)===JSON.stringify(d.identity)&&JSON.stringify(d.identity)===JSON.stringify(old.descriptor.identity);}catch{return false;}}};
}
