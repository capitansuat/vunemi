/** Automated installed-native fixture, not installed-model or human typing acceptance. */
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {Helper} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import type {OperationRecord} from '../src/operation-journal.js';
import type {ToolContext} from '@vunemi/agent-core';
it.skipIf(process.platform!=='darwin'||process.env.VUNEMI_CALCULATOR_LIVE!=='1')('one exact All Clear press preserves foreground and unrelated unknown delivery',async()=>{
 const root=resolve('../../research/concurrent-typing-2026-10-15/native-automated',new Date().toISOString().replaceAll(':','-'));mkdirSync(root,{recursive:true,mode:0o700});
 const production=join(homedir(),'Library/Application Support/Vunemi/background-operations.json');
 const old=(JSON.parse(readFileSync(production,'utf8')).records as OperationRecord[]).find(r=>r.dispatchId==='37f42b3d-a0f1-4e3a-8736-c746053b520c');
 expect(old).toMatchObject({state:'unknown',op:'background_save_document',target:{bundleId:'com.apple.TextEdit'}});
 const journal=join(root,'journal.json');writeFileSync(journal,JSON.stringify({version:1,records:[old]}),{mode:0o600});
 const helper=new Helper('/Applications/Vunemi.app/Contents/Resources/VunemiHelper',{operationJournalPath:journal});
 const evidence:Record<string,unknown>={startedAt:new Date().toISOString(),method:'automated signed installed helper + source tools; not model E2E or human typing acceptance',seed:'exact old unknown copied read-only into isolated fixture journal',onePress:0};
 const ctx:ToolContext={runId:`calculator-fixture-${Date.now()}`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){}};
 try{
  const before=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundBefore=before;expect(before).toBeDefined();expect(before!.bundleId).not.toBe('com.apple.calculator');
  const tools=createDesktopTools({helper,settleMs:0}),describe=tools.find(t=>t.name==='desktop_background_describe')!,press=tools.find(t=>t.name==='desktop_background_click')!;
  const observed=JSON.parse(String(await describe.run({app:'com.apple.calculator'},ctx)));evidence.before=observed;evidence.observationAt=new Date().toISOString();expect(observed.bundleId).toBe('com.apple.calculator');expect(observed.controlMode).toBe('backgroundStrict');
  const matches=observed.targets.filter((t:{label:string;role:string;backgroundActions:string[]})=>t.label==='All Clear'&&t.role==='AXButton'&&t.backgroundActions.includes('press'));expect(matches).toHaveLength(1);
  const args={app:'com.apple.calculator',snapshotId:observed.snapshotId,ref:matches[0].ref,label:matches[0].label};expect(await press.check!(args)).toBe(null);
  evidence.pressStartedAt=new Date().toISOString();evidence.result=JSON.parse(String(await press.run(args,ctx)));evidence.pressSettledAt=new Date().toISOString();
  const afterObservation=JSON.parse(String(await describe.run({app:'com.apple.calculator',windowId:observed.windowId},ctx)));evidence.after=afterObservation;evidence.independentReadAt=new Date().toISOString();
  expect(afterObservation.bundleId).toBe(observed.bundleId);expect(afterObservation.processStartedAt).toBe(observed.processStartedAt);expect(afterObservation.windowId).toBe(observed.windowId);expect(afterObservation.inputValues).toContain('0');
  const records=JSON.parse(readFileSync(journal,'utf8')).records as OperationRecord[];expect(records.filter(r=>r.dispatchId===old!.dispatchId)).toEqual([old]);
  const added=records.filter(r=>r.dispatchId!==old!.dispatchId);evidence.journalRecords=records;evidence.onePress=added.filter(r=>r.op==='background_press').length;expect(added).toHaveLength(1);expect(added[0]).toMatchObject({op:'background_press',state:'native-result',ownerRunId:ctx.runId,target:{bundleId:'com.apple.calculator',windowId:observed.windowId}});
  await helper.releaseRun(ctx.runId!);expect(helper.queryOperation(old!.dispatchId)).toEqual(old);
  const after=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundAfter=after;expect(after?.pid).toBe(before!.pid);expect(after?.bundleId).toBe(before!.bundleId);evidence.status='pass';
 }catch(error){evidence.status='failed';evidence.error=String(error);throw error;}finally{evidence.finishedAt=new Date().toISOString();writeFileSync(join(root,'summary.json'),JSON.stringify(evidence,null,2),{mode:0o600});helper.dispose();}
},45000);
