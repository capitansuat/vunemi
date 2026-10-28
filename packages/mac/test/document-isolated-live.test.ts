/** Actual source document flow with installed signed native helper; never replay the old append. */
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {Helper} from '../src/helper.js';
import {backgroundDocumentTool} from '../src/document.js';
import type {ToolContext,DesktopEvidence} from '@vunemi/agent-core';
import type {OperationRecord} from '../src/operation-journal.js';
it.skipIf(process.platform!=='darwin'||process.env.VUNEMI_ISOLATED_DOCUMENT_LIVE!=='1')('new synthetic document saves while old exact-target uncertainty remains blocked and audited',async()=>{
 const dir=resolve('../../research/document-save-debug-2026-10-15',new Date().toISOString().replaceAll(':','-'));mkdirSync(dir,{recursive:true,mode:0o700});const root=realpathSync(dir),path=join(root,'new-isolated.txt'),journal=join(root,'journal.json');
 const production=join(homedir(),'Library/Application Support/Vunemi/background-operations.json');const old=(JSON.parse(readFileSync(production,'utf8')).records as OperationRecord[]).find(r=>r.dispatchId==='37f42b3d-a0f1-4e3a-8736-c746053b520c');expect(old).toMatchObject({state:'unknown',target:{bundleId:'com.apple.TextEdit'}});writeFileSync(journal,JSON.stringify({version:1,records:[old]}),{mode:0o600});
 const baseline='New isolated document baseline|',text='NEW-ISOLATED-APPEND';writeFileSync(path,baseline);const helper=new Helper('/Applications/Vunemi.app/Contents/Resources/VunemiHelper',{operationJournalPath:journal});const receipts:DesktopEvidence[]=[];const evidence:Record<string,unknown>={at:new Date().toISOString(),path,method:'source document tool and installed signed helper, copied isolated journal; not installed model E2E'};
 try{
  const before=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundBefore=before;expect(before).toBeDefined();expect(before!.bundleId).not.toBe('com.apple.TextEdit');
  await expect(helper.call('background_save_document',{app:String(old!.target!.pid)},{ownerRunId:'forbidden-old-retry',target:old!.target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});expect(JSON.parse(readFileSync(journal,'utf8')).records).toEqual([old]);
  const tool=backgroundDocumentTool(helper,async()=>{expect((await helper.permissions(false)).accessibility).toBe(true);});const args={path,text};expect(await tool.check!(args)).toBe(null);
  const ctx:ToolContext={runId:`isolated-live-${Date.now()}`,userGoal:`TextEdit arka planda ${path} belgesine "${text}" ekle ve kaydet.`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){},recordDesktopEvidence:e=>receipts.push(e),desktopDocumentState:()=>({receipts:[...receipts],uncertain:false})};
  evidence.result=JSON.parse(String(await tool.run(args,ctx)));expect(readFileSync(path,'utf8')).toBe(baseline+text);expect(receipts.map(r=>r.kind)).toEqual(['observation','verified-append','verified-save']);await helper.releaseRun(ctx.runId!);
  const after=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundAfter=after;expect(after?.pid).toBe(before!.pid);expect(after?.bundleId).toBe(before!.bundleId);
  const records=JSON.parse(readFileSync(journal,'utf8')).records as OperationRecord[];expect(records.filter(r=>r.dispatchId===old!.dispatchId)).toEqual([old]);expect(records.filter(r=>r.dispatchId!==old!.dispatchId).map(r=>[r.op,r.state])).toEqual([['background_open_document','native-result'],['background_set_value','native-result'],['background_save_document','native-result']]);evidence.records=records;
  const still=(JSON.parse(readFileSync(production,'utf8')).records as OperationRecord[]).find(r=>r.dispatchId===old!.dispatchId);expect(still).toEqual(old);evidence.oldProductionUnknownUnchanged=true;evidence.receipts=receipts;evidence.status='pass';
 }catch(error){evidence.status='failed';evidence.error=String(error);throw error;}finally{writeFileSync(join(root,'isolated-save-summary.json'),JSON.stringify(evidence,null,2),{mode:0o600});helper.dispose();}
},90000);
