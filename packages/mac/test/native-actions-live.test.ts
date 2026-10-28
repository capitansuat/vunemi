import {it,expect} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Helper} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import type {ToolContext} from '@vunemi/agent-core';

it.skipIf(process.env.VUNEMI_NATIVE_ACTIONS_LIVE!=='1')('actual source semantic scroll/menu on signed owned fixture',async()=>{
 const root=resolve('../../research/vun12-expansion-2026-10-15/native');
 const info=JSON.parse(readFileSync(join(root,'fixture-pid.json'),'utf8'));
 const phase=process.env.VUNEMI_NATIVE_ACTIONS_PHASE??'all';
 expect(['all','menu']).toContain(phase);
 const dir=join(root,'live',new Date().toISOString().replaceAll(':','-'));
 mkdirSync(dir,{recursive:true,mode:0o700});
 // Copy the entire isolated audit, including known effects: no clearing or replay of old records.
 if(info.seedJournal)writeFileSync(join(dir,'journal.json'),readFileSync(info.seedJournal));
 const helper=new Helper('/private/tmp/vun12-owned-native/VunemiHelper',{operationJournalPath:join(dir,'journal.json')});
 const tools=createDesktopTools({helper,settleMs:0});
 const proof:Record<string,unknown>={method:'source registered tools + separately signed helper/owned fixture; simulated single-operation approval, not installed acceptance',pid:info.pid,phase};
 const ctx:ToolContext={runId:`native-actions-${Date.now()}`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){}};
 const readState=()=>JSON.parse(readFileSync(info.statePath??join(root,'fixture-state.json'),'utf8'));
 const environment=async()=>{
  const e=await helper.call('background_environment') as {verified:boolean;unlocked:boolean;foregroundPid:number;cursor:{x:number;y:number}};
  expect(e.verified).toBe(true);expect(e.unlocked).toBe(true);expect(e.foregroundPid).not.toBe(info.pid);return e;
 };
 const observe=async()=>JSON.parse(String(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:String(info.pid),windowId:readState().windowId,windowTitle:'Scope Native Fixture'},ctx)));
 const effect=async(name:string,args:Record<string,unknown>,label:string)=>{
  const tool=tools.find(t=>t.name===name)!;
  expect(tool.alwaysAsk).toBe(true);expect(await tool.check!(args)).toBe(null);
  proof[`${label}EnvironmentBefore`]=await environment();
  const result=JSON.parse(String(await tool.run(args,ctx)));
  proof[`${label}Result`]=result;proof[`${label}EnvironmentAfter`]=await environment();
  // Native records the immediate dispatch/readback interval. Whole-test cursor changes
  // can be independent user activity and are preserved separately, never attributed.
  expect(result.foregroundChanged).toBe(false);expect(result.cursorChanged).toBe(false);
  expect(['verified','delivered']).toContain(result.status);return result;
 };
 try{
  const before=await environment();proof.environmentBefore=before;proof.stateBefore=readState();
  let observed=await observe();proof.initialObservation=observed;expect(observed.pid).toBe(info.pid);
  if(phase==='all'){
   const scroll=observed.extendedTargets.find((t:{actions:string[]})=>t.actions.includes('scroll-position'));
   expect(scroll).toBeDefined();
   await effect('desktop_background_scroll_position',{targetId:scroll.targetId,expectedPosition:scroll.scroll.current,position:(scroll.scroll.min+scroll.scroll.max)*0.6},'scroll');
   for(let n=0;n<20&&readState().scrollOriginY===0;n++)await new Promise(r=>setTimeout(r,100));
   proof.stateAfterScroll=readState();expect(readState().scrollOriginY).toBeGreaterThan(0);
  }
  observed=await observe();
  const popup=observed.extendedTargets.find((t:{actions:string[]})=>t.actions.includes('menu-open'));
  expect(popup).toBeDefined();
  await effect('desktop_background_menu_open',{targetId:popup.targetId},'menuOpen');
  observed=await observe();proof.openMenuObservation=observed;
  const owner=observed.extendedTargets.find((t:{actions:string[]})=>t.actions.includes('menu-open'));
  const item=observed.extendedTargets.find((t:{actions:string[];label:string})=>t.actions.includes('menu-select')&&t.label==='Blue');
  expect(item).toBeDefined();
  await effect('desktop_background_menu_select',{menuTargetId:owner.targetId,itemId:item.targetId},'menuSelect');
  for(let n=0;n<20&&readState().selected!=='Blue';n++)await new Promise(r=>setTimeout(r,100));
  proof.stateAfterMenu=readState();expect(readState().selected).toBe('Blue');
  proof.finalObservation=await observe();const after=await environment();proof.environmentAfter=after;
  proof.wholeTestCursorEndpointsEqual=JSON.stringify(after.cursor)===JSON.stringify(before.cursor);
  expect(after.foregroundPid).toBe(before.foregroundPid);
  await helper.releaseRun(ctx.runId!);proof.status='pass';
 }catch(error){
  proof.status='failed';proof.error=String(error);
  const e=error as {deliveryUnknown?:boolean;noInputSent?:boolean;reasonCode?:string;nativeResult?:unknown};
  proof.failure={deliveryUnknown:e.deliveryUnknown,noInputSent:e.noInputSent,reasonCode:e.reasonCode,nativeResult:e.nativeResult};
  throw error;
 }finally{writeFileSync(join(dir,'summary.json'),JSON.stringify(proof,null,2));helper.dispose();}
},60000);
