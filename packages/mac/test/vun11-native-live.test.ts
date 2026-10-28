/** Actual signed helper fixture. Does not replace the human simultaneous typing acceptance. */
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {Helper} from '../src/helper.js';
import {backgroundDocumentTool} from '../src/document.js';
import type {ToolContext,DesktopEvidence} from '@vunemi/agent-core';
it.skipIf(process.platform!=='darwin'||process.env.VUNEMI_DESKTOP_LIVE!=='1')('actual native document preserves foreground, excludes another owner and releases known ownership',async()=>{
 const dir=resolve('../../research/vun11-native-2026-10-15',new Date().toISOString().replaceAll(':','-'));mkdirSync(dir,{recursive:true});const root=realpathSync(dir),path=join(root,'fixture.txt'),journal=join(root,'journal.json');const original='VUN-11 synthetic fixture.\n',append='Lease acceptance appended once.\n';writeFileSync(path,original);
 const helper=new Helper('/Applications/Vunemi.app/Contents/Resources/VunemiHelper',{operationJournalPath:journal});const owner='vun11-native-owner',other='vun11-native-other';const evidence:Record<string,unknown>={method:'actual signed helper, source Helper and document tool; no human typing claim',path};const receipts:DesktopEvidence[]=[];
 try{
  const permissions=await helper.permissions(false);evidence.permissions=permissions;expect(permissions.accessibility).toBe(true);
  const before=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundBefore=before;expect(before?.bundleId).not.toBe('com.apple.TextEdit');
  const opened=await helper.call('background_open_document',{path},{ownerRunId:owner}) as {bundleId:string;pid:number;processStartedAt:number;windowId:number};const target={bundleId:opened.bundleId,pid:opened.pid,processStartedAt:opened.processStartedAt,windowId:opened.windowId};evidence.target=target;
  const count=JSON.parse(readFileSync(journal,'utf8')).records.length;
  await expect(helper.call('background_save_document',{app:String(target.pid),path},{ownerRunId:other,target})).rejects.toMatchObject({reasonCode:'target-busy',noInputSent:true,deliveryUnknown:false});expect(JSON.parse(readFileSync(journal,'utf8')).records).toHaveLength(count);evidence.competingOwnerRejectedBeforeJournal=true;
  const tool=backgroundDocumentTool(helper,async()=>{const p=await helper.permissions(false);if(!p.accessibility)throw Error('Permission revoked');});const args={path,text:append};expect(await tool.check!(args)).toBe(null);
  const ctx:ToolContext={runId:owner,userGoal:`TextEdit arka planda ${path} belgesine "${append}" ekle ve kaydet.`,signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){},recordDesktopEvidence:e=>receipts.push(e),desktopDocumentState:()=>({receipts:[...receipts],uncertain:false})};
  evidence.result=JSON.parse(String(await tool.run(args,ctx)));expect(readFileSync(path,'utf8')).toBe(original+append);expect(receipts.some(e=>e.kind==='verified-save')).toBe(true);
  await helper.releaseRun(owner);await helper.call('background_open_document',{path},{ownerRunId:other});await helper.releaseRun(other);evidence.knownOwnerReleased=true;
  const after=(await helper.apps()).find(a=>a.frontmost);evidence.foregroundAfter=after;expect(after?.pid).toBe(before?.pid);expect(after?.bundleId).toBe(before?.bundleId);evidence.receipts=receipts;evidence.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');evidence.status='pass';
 }catch(error){evidence.status='failed';evidence.error=String(error);throw error;}finally{writeFileSync(join(root,'summary.json'),JSON.stringify(evidence,null,2));helper.dispose();}
},90000);
