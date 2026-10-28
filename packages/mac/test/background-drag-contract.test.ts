vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Helper} from '../src/helper.js';
const target={bundleId:'org.scope.fixture',pid:123,processStartedAt:100,windowId:9};
const args={app:'123',snapshotId:'snapshot',ref:10,label:'Source',destinationRef:11,destinationLabel:'Destination'};
const fake=(h:Helper)=>vi.spyOn(h as unknown as {transport:()=>Promise<unknown>},'transport');
it('unadvertised native drag cannot bypass run ownership or durable journaling',async()=>{
 for(const mode of ['missing-owner','missing-journal']){
  const h=new Helper(process.execPath),transport=fake(h).mockResolvedValue({status:'delivered'});
  await expect(h.call('background_drag',args,mode==='missing-owner'?{}:{ownerRunId:'owner',target})).rejects.toMatchObject({noInputSent:true});expect(transport).not.toHaveBeenCalled();
 }
});
it('native drag dispatch uncertainty stays journaled and leased after settlement and restart',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-contract-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});
 const transport=fake(h).mockRejectedValue(Error('lost after dispatch'));
 await expect(h.call('background_drag',args,{ownerRunId:'owner',target})).rejects.toMatchObject({deliveryUnknown:true,noInputSent:false});
 await h.releaseRun('owner');const record=JSON.parse(readFileSync(path,'utf8')).records[0];expect(record).toMatchObject({op:'background_drag',state:'unknown',target});
 const restarted=new Helper(process.execPath,{operationJournalPath:path}),again=fake(restarted);
 await expect(restarted.call('background_drag',args,{ownerRunId:'other',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});expect(again).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(1);
});
it('Stop before native drag dispatch produces no journal dispatch or transport',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-stop-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path}),transport=fake(h),abort=new AbortController();abort.abort();
 await expect(h.call('background_drag',args,{ownerRunId:'owner',target,signal:abort.signal})).rejects.toMatchObject({noInputSent:true,reasonCode:'stopped'});expect(transport).not.toHaveBeenCalled();
});
it('native drag holds the single writer and run settlement until dispatch actually settles',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-settle-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});let finish!:(value:unknown)=>void;
 const transport=fake(h).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=h.call('background_drag',args,{ownerRunId:'owner',target});await Promise.resolve();
 await expect(h.call('background_drag',args,{ownerRunId:'other',target})).rejects.toMatchObject({noInputSent:true,reasonCode:'helper-busy'});
 let settled=false;const closing=h.releaseRun('owner').then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
 finish({status:'delivered',foregroundChanged:false,cursorChanged:false});await pending;await closing;expect(transport).toHaveBeenCalledTimes(1);
 await expect(h.call('background_drag',args,{ownerRunId:'owner',target})).rejects.toMatchObject({noInputSent:true,reasonCode:'owner-closed'});
});
it('does not clear durable unknown on claimed verified drag with forged result tolerance',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-bad-receipt-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});fake(h).mockResolvedValue({status:'verified',foregroundChanged:false,cursorChanged:false,dragResult:{requestedValue:75,actualValue:40,tolerance:100}});
 const result=await h.call('background_drag',args,{ownerRunId:'owner',target,dragExpectation:{requestedValue:75,tolerance:100/380,min:0,max:100}}) as {deliveryUnknown:boolean;dispatchId:string};expect(result.deliveryUnknown).toBe(true);expect(h.queryOperation(result.dispatchId)?.state).toBe('unknown');await h.releaseRun('owner');await expect(h.call('background_drag',args,{ownerRunId:'next',target})).rejects.toMatchObject({noInputSent:true,reasonCode:'delivery-blocked'});
});
