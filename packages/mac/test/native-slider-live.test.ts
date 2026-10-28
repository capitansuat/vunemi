/** Opt-in NEW owned slider fixture only. Source tools + explicit one-operation approval simulation; not installed model acceptance. */
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Helper,type HelperCallOptions} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import type {ToolContext,ToolCheckContext} from '@vunemi/agent-core';
it.skipIf(process.env.VUNEMI_SLIDER_LIVE!=='1')('real owned standard slider drag75 has fresh AX readback and stable actual host',async()=>{
 const requested=Number(process.env.VUNEMI_SLIDER_VALUE??75);expect(Number.isFinite(requested)).toBe(true);
 const info=JSON.parse(readFileSync(process.env.VUNEMI_SLIDER_FIXTURE_INFO!,'utf8')) as {pid:number;windowId:number;windowTitle?:string;statePath?:string};
 expect(Number.isSafeInteger(info.pid)&&info.pid>0).toBe(true);expect(Number.isSafeInteger(info.windowId)&&info.windowId>0).toBe(true);
 const evidence=resolve(process.env.VUNEMI_SLIDER_EVIDENCE??mkdtempSync(join(tmpdir(),'native-slider-proof-')));mkdirSync(evidence,{recursive:true});
 class PinnedHelper extends Helper{calls:string[]=[];override async call(op:string,args:Record<string,unknown>={},opts:HelperCallOptions={}){this.calls.push(op);if(!['permissions','apps','describe','validate_background_action','background_drag','background_environment'].includes(op))throw Error('Unapproved live fixture operation');if(['describe','validate_background_action','background_drag'].includes(op)&&String(args.app)!==String(info.pid))throw Error('Wrong fixture process');if(op==='describe'&&(args.background!==true||args.windowId!==info.windowId||args.part!=='window'))throw Error('Wrong fixture window');return super.call(op,args,opts);}}
 const helper=new PinnedHelper(process.env.VUNEMI_SLIDER_HELPER!,{operationJournalPath:join(evidence,'journal.json')}),tools=createDesktopTools({helper,settleMs:0}),ctx:ToolContext&ToolCheckContext={runId:`slider-live-${Date.now()}`,signal:new AbortController().signal,assertToolActive(){},handoff:async()=>false,offerUndo(){},attach(){}};
 const proof:Record<string,unknown>={helperHash:createHash('sha256').update(readFileSync(process.env.VUNEMI_SLIDER_HELPER!)).digest('hex'),method:'source registered slider tool + signed scratch helper + NEW owned standard AppKit slider; simulated single-operation approval, not installed model acceptance'};
 try{
  const before=await helper.call('background_environment') as {verified:boolean;unlocked:boolean;foregroundPid:number;cursor:unknown};expect(before.verified).toBe(true);expect(before.unlocked).toBe(true);expect(before.foregroundPid).not.toBe(info.pid);proof.before=before;
  const describe=tools.find(t=>t.name==='desktop_background_describe')!,drag=tools.find(t=>t.name==='desktop_background_drag')!;
  const observation=JSON.parse(String(await describe.run({app:String(info.pid),windowId:info.windowId,...(info.windowTitle?{windowTitle:info.windowTitle}:{})},ctx)));proof.observation=observation;
  const target=observation.extendedTargets.find((t:{profile:string;actions:string[]})=>t.profile==='scope-fixture-slider-v1'&&t.actions.includes('drag'));expect(target).toBeDefined();
  const args={targetId:target.targetId,value:requested};proof.preview=await drag.preview!(args);expect(drag.alwaysAsk).toBe(true);expect(drag.allowSessionApproval).not.toBe(true);await drag.check!(args,ctx);proof.approval='explicit test single-operation approval simulation';
  const result=JSON.parse(String(await drag.run(args,ctx)));proof.result=result;expect(result.status).toBe('verified');expect(Math.abs(result.dragResult.actualValue-requested)).toBeLessThanOrEqual(target.drag.valueTolerance);expect(result.foregroundChanged).toBe(false);expect(result.cursorChanged).toBe(false);
  const fresh=JSON.parse(String(await describe.run({app:String(info.pid),windowId:info.windowId,...(info.windowTitle?{windowTitle:info.windowTitle}:{})},ctx)));proof.fresh=fresh;
  const now=fresh.extendedTargets.find((t:{profile:string})=>t.profile==='scope-fixture-slider-v1');expect(Math.abs(now.drag.current-requested)).toBeLessThanOrEqual(target.drag.valueTolerance);
  const after=await helper.call('background_environment') as typeof before;proof.after=after;expect(after.verified).toBe(true);expect(after.unlocked).toBe(true);expect(after.foregroundPid).toBe(before.foregroundPid);expect(after.cursor).toEqual(before.cursor);
  if(info.statePath)proof.fixtureState=JSON.parse(readFileSync(info.statePath,'utf8'));expect(helper.calls.filter(op=>op==='background_drag')).toHaveLength(1);proof.status='pass';
 }catch(error){proof.status='failed';proof.error=error instanceof Error?error.message:String(error);if(error&&typeof error==='object'&&'nativeResult' in error)proof.nativeResult=error.nativeResult;throw error;}finally{
  if(!proof.after)try{proof.after=await helper.call('background_environment');}catch(error){proof.afterEnvironmentError=error instanceof Error?error.message:String(error);}
  if(!proof.fixtureState&&info.statePath)try{proof.fixtureState=JSON.parse(readFileSync(info.statePath,'utf8'));}catch(error){proof.fixtureStateError=error instanceof Error?error.message:String(error);}
  if(!proof.fresh)try{proof.fresh=JSON.parse(String(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:String(info.pid),windowId:info.windowId,...(info.windowTitle?{windowTitle:info.windowTitle}:{})},ctx)));}catch(error){proof.freshReadError=error instanceof Error?error.message:String(error);}
  proof.calls=helper.calls;writeFileSync(join(evidence,'summary.json'),JSON.stringify(proof,null,2));await helper.releaseRun(ctx.runId);helper.dispose();}
},30000);
