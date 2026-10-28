/** Actual native discovery only. Never opens apps or dispatches native input. */
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Helper,type HelperCallOptions} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import {backgroundCapabilities} from '../src/background-capabilities.js';
import type {ToolContext} from '@vunemi/agent-core';
class ReadOnlyHelper extends Helper {
 readonly calls:string[]=[];
 pinned:{pid:number;windowId?:number}|undefined;
 override async call(op:string,args:Record<string,unknown>={},opts:HelperCallOptions={}){this.calls.push(op);if(!['permissions','apps','windows','describe'].includes(op))throw Error('Matrix forbids this native operation');if(['windows','describe'].includes(op)&&(!this.pinned||String(args.app)!==String(this.pinned.pid)))throw Error('Unpinned fixture process');if(op==='describe'&&(args.background!==true||args.part!=='window'||!this.pinned?.windowId||args.windowId!==this.pinned.windowId))throw Error('Unpinned fixture window');return super.call(op,args,opts);}
}
it.skipIf(process.platform!=='darwin'||process.env.VUNEMI_MATRIX_LIVE!=='1')('records available pinned fixtures and explicit partial coverage without native input',async()=>{
 const browserTitle=process.env.VUNEMI_MATRIX_BROWSER_TITLE,browserPID=Number(process.env.VUNEMI_MATRIX_BROWSER_PID);expect(browserTitle).toBeTruthy();expect(Number.isSafeInteger(browserPID)&&browserPID>0).toBe(true);
 const dir=resolve('../../research/vun12-capabilities-2026-10-15/matrix',new Date().toISOString().replaceAll(':','-'));mkdirSync(dir,{recursive:true,mode:0o700});const journal=join(dir,'isolated-journal.json'),empty=JSON.stringify({version:1,records:[]});writeFileSync(journal,empty,{mode:0o600});
 const helper=new ReadOnlyHelper('/Applications/Vunemi.app/Contents/Resources/VunemiHelper',{operationJournalPath:journal}),tools=createDesktopTools({helper,settleMs:0}),describe=tools.find(t=>t.name==='desktop_background_describe')!,click=tools.find(t=>t.name==='desktop_background_click')!;
 const ctx:ToolContext={runId:`matrix-${Date.now()}`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){}};
 const rows:Record<string,unknown>[]=[];const summary:Record<string,unknown>={method:'source registered tools + installed signed native helper; read-only discovery only',startedAt:new Date().toISOString(),rows,mutations:0};
 try{
  const apps=await helper.apps(),front=apps.find(a=>a.frontmost);expect(front).toBeDefined();summary.foregroundBefore=front?{pid:front.pid,bundleId:front.bundleId}:null;
  const fixtures=[{kind:'native-calculator',bundleId:'com.apple.calculator',pid:96408,windowId:586,title:'Calculator',startedAt:1792058851.392853,actions:['press']},{kind:'native-textedit',bundleId:'com.apple.TextEdit',pid:72538,windowId:736,title:'installed-document-2.txt',startedAt:1792055325.980042,actions:['set-value']},{kind:'browser-semantic-and-static-canvas',bundleId:'com.google.Chrome',pid:browserPID,windowId:undefined as number|undefined,title:browserTitle!,startedAt:undefined as number|undefined,actions:[] as string[]}];
  for(const fixture of fixtures){
   if(!apps.some(a=>a.bundleId===fixture.bundleId&&a.pid===fixture.pid)){rows.push({kind:fixture.kind,bundleId:fixture.bundleId,pid:fixture.pid,status:'app-unavailable',capabilities:null,inputSent:false});continue;}
   helper.pinned={pid:fixture.pid,...(fixture.windowId?{windowId:fixture.windowId}:{})};
   if(!fixture.windowId){const windows=JSON.parse(String(await tools.find(t=>t.name==='desktop_windows')!.run({app:fixture.bundleId},ctx))).windows as {title:string;windowId:number}[];const matching=windows.filter(w=>[fixture.title,`${fixture.title} - Google Chrome`].includes(w.title));expect(matching).toHaveLength(1);fixture.title=matching[0]!.title;fixture.windowId=matching[0]!.windowId;helper.pinned.windowId=fixture.windowId;}
   const start=helper.calls.length;
   const observed=JSON.parse(String(await describe.run({app:fixture.bundleId,windowTitle:fixture.title,...(fixture.windowId?{windowId:fixture.windowId}:{})},ctx)));
   const row={kind:fixture.kind,status:'observed',bundleId:observed.bundleId,pid:observed.pid,processStartedAt:observed.processStartedAt,windowId:observed.windowId,snapshotId:observed.snapshotId,observedAt:observed.observedAt,controlMode:observed.controlMode,targetCount:observed.targets?.length,actionCounts:{press:observed.targets?.filter((t:{backgroundActions:string[]})=>t.backgroundActions.includes('press')).length,'set-value':observed.targets?.filter((t:{backgroundActions:string[]})=>t.backgroundActions.includes('set-value')).length},capabilities:observed.capabilities,nativeReadOps:helper.calls.slice(start)};rows.push(row);
   expect(observed.bundleId).toBe(fixture.bundleId);expect(observed.pid).toBe(fixture.pid);if(fixture.startedAt)expect(observed.processStartedAt).toBe(fixture.startedAt);if(fixture.windowId)expect(observed.windowId).toBe(fixture.windowId);expect(observed.capabilities).toEqual(backgroundCapabilities(observed));expect(observed.capabilities.observedActions).toEqual(fixture.actions);expect(observed.capabilities.unsupportedActions).toEqual(['menu','scroll','drag']);
   // Do not persist observed.text, labels, values, document contents or paths.
  }
  for(const app of ['com.vunemi.app','com.github.Electron']){const start=helper.calls.length;await expect(click.check!({app,snapshotId:'not-authority',ref:1,label:'not-authority'})).rejects.toMatchObject({retryable:false});const calls=helper.calls.slice(start);expect(calls).toEqual(['permissions']);rows.push({kind:'control-plane',bundleId:app,status:'policy-denied-before-observation',nativeReadOps:calls,capabilities:null});}
  const after=(await helper.apps()).find(a=>a.frontmost);summary.foregroundAfter=after?{pid:after.pid,bundleId:after.bundleId}:null;expect(after?.pid).toBe(front!.pid);expect(after?.bundleId).toBe(front!.bundleId);expect(readFileSync(journal,'utf8')).toBe(empty);summary.journalEffects=0;summary.nativeOps=helper.calls;const missing=rows.filter(r=>r.status==='app-unavailable').length;summary.status=missing?'partial':'pass';summary.coverage={observed:rows.filter(r=>r.status==='observed').map(r=>r.kind),unobserved:rows.filter(r=>r.status==='app-unavailable').map(r=>r.kind),electron:'not-tested (control-plane policy rejection only)',canvas:'not-established (static canvas fixture shares browser row; no independent canvas control proof)'};expect(rows.filter(r=>r.status==='policy-denied-before-observation')).toHaveLength(2);if(missing)expect(summary.status).toBe('partial');
 }catch(error){summary.status='failed';summary.errorType=error instanceof Error?error.name:'unknown';summary.error='Read-only matrix did not meet a pinned fixture/identity/policy assertion; no mutation authorized.';throw error;}finally{summary.finishedAt=new Date().toISOString();writeFileSync(join(dir,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});helper.dispose();}
},60000);
