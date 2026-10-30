/** Automated native check on apps the user has open: VUNEMI_APPS_LIVE=1, VUNEMI_APPS_HELPER, VUNEMI_APPS_JOURNAL. Synthetic documents only. */
import {it,expect} from 'vitest';
import {Helper} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import type {ToolContext} from '@vunemi/agent-core';
const live=process.platform==='darwin'&&process.env.VUNEMI_APPS_LIVE==='1';
type Target={ref:number;role:string;label:string;value?:string;backgroundActions:string[];targetId?:string};
const setup=()=>{
 const helper=new Helper(process.env.VUNEMI_APPS_HELPER!,{operationJournalPath:process.env.VUNEMI_APPS_JOURNAL!});
 const tools=createDesktopTools({helper,settleMs:0});
 const ctx:ToolContext={runId:`scheduled-apps-${Date.now()}`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){}};
 const tool=(name:string)=>tools.find(t=>t.name===name)!;
 const look=async(app:string,windowTitle?:string)=>JSON.parse(String(await tool('desktop_background_describe').run({app,...(windowTitle&&{windowTitle})},ctx)));
 return {helper,ctx,tool,look};
};
it.skipIf(!live)('lists what each app offers, without values',async()=>{
 const {helper,look}=setup();
 try{for(const app of (process.env.VUNEMI_APPS_LIST??'').split(',')){
  const o=await look(app);const targets=o.targets as Target[];
  console.log(app,JSON.stringify({buttons:targets.filter(t=>t.backgroundActions.includes('press')).map(t=>t.label).slice(0,40),text:targets.filter(t=>t.backgroundActions.includes('set-value')).map(t=>t.role)}));
 }}finally{helper.dispose();}
},60000);
it.skipIf(!live||!process.env.VUNEMI_APPS_PRESS)('presses one named button, foreground and cursor untouched',async()=>{
 const {helper,ctx,tool,look}=setup();const [app,label]=process.env.VUNEMI_APPS_PRESS!.split('=');
 try{
  const before=(await helper.apps()).find(a=>a.frontmost);const o=await look(app!,process.env.VUNEMI_APPS_WINDOW);
  const hit=(o.targets as Target[]).filter(t=>t.label===label&&t.backgroundActions.includes('press'));expect(hit).toHaveLength(1);
  const args={app:app!,snapshotId:o.snapshotId,ref:hit[0]!.ref,label:hit[0]!.label};expect(await tool('desktop_background_click').check!(args as never,ctx as never)).toBe(null);
  const r=JSON.parse(String(await tool('desktop_background_click').run(args,ctx)));
  console.log(app,label,JSON.stringify({status:r.status,foregroundChanged:r.foregroundChanged,cursorChanged:r.cursorChanged,changed:String(r.changed).length}));
  expect(r.foregroundChanged).toBe(false);expect(r.cursorChanged).toBe(false);expect((await helper.apps()).find(a=>a.frontmost)?.pid).toBe(before?.pid);
 }finally{await helper.releaseRun(ctx.runId!);helper.dispose();}
},60000);
it.skipIf(!live||!process.env.VUNEMI_APPS_TEXT)('sets the text of an empty or synthetic field and reads it back',async()=>{
 const {helper,ctx,tool,look}=setup();const [app,title,text]=process.env.VUNEMI_APPS_TEXT!.split('|');
 try{
  const before=(await helper.apps()).find(a=>a.frontmost);const o=await look(app!,title||undefined);
  const hit=(o.targets as Target[]).filter(t=>t.role==='AXTextArea'&&t.backgroundActions.includes('set-value'));expect(hit).toHaveLength(1);
  const expected=hit[0]!.value??'';expect(process.env.VUNEMI_APPS_EXPECT??'').toBe(expected);
  const args={app:app!,snapshotId:o.snapshotId,ref:hit[0]!.ref,label:hit[0]!.label,expectedValue:expected,text:text!};expect(await tool('desktop_background_set_text').check!(args as never,ctx as never)).toBe(null);
  const r=JSON.parse(String(await tool('desktop_background_set_text').run(args,ctx)));
  console.log(app,JSON.stringify({status:r.status,foregroundChanged:r.foregroundChanged,cursorChanged:r.cursorChanged}));
  expect(r.status).toBe('verified');expect((await helper.apps()).find(a=>a.frontmost)?.pid).toBe(before?.pid);
 }finally{await helper.releaseRun(ctx.runId!);helper.dispose();}
},60000);
