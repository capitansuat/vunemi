vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Helper} from '../src/helper.js';

const directories:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const target={bundleId:'com.apple.TextEdit',pid:12345,processStartedAt:123,windowId:67};
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'vun13-helper-'));directories.push(directory);
 const binary=join(directory,'fixture-helper'),journalPath=join(directory,'journal.json');writeFileSync(binary,'fixture');
 const helper=new Helper(binary,{operationJournalPath:journalPath});
 const records=()=>JSON.parse(readFileSync(journalPath,'utf8')).records as {dispatchId:string;state:string;op:string}[];
 return{directory,helper,records};
}
it('persists prepared child before beforeDispatch and dispatched child before transport',async()=>{
 const f=fixture(),order:string[]=[],link=join(f.directory,'parent-link');let dispatchId='';
 const transport=vi.spyOn(f.helper as any,'transport').mockImplementation(async()=>{
  order.push('transport');expect(f.records()).toEqual([expect.objectContaining({dispatchId,state:'dispatched',op:'scheduled_document_append'})]);
  expect(readFileSync(link,'utf8')).toBe(dispatchId);return{status:'verified'};
 });
 await f.helper.call('scheduled_document_append',{app:String(target.pid),handle:'opaque',deadline:123},{ownerRunId:'recipe-owner',target,beforeDispatch:id=>{
  order.push('beforeDispatch');dispatchId=id;
  expect(f.records()).toEqual([expect.objectContaining({dispatchId:id,state:'prepared',op:'scheduled_document_append'})]);
  expect(transport).not.toHaveBeenCalled();
  const fd=openSync(link,'wx');try{writeFileSync(fd,id);fsyncSync(fd);}finally{closeSync(fd);}
 }});
 expect(order).toEqual(['beforeDispatch','transport']);expect(f.records()[0]!.state).toBe('native-result');
});
it('retains unknown child and target lease when parent persistence hook throws without transport',async()=>{
 const f=fixture(),transport=vi.spyOn(f.helper as any,'transport').mockResolvedValue({status:'verified'});let dispatchId='';
 await expect(f.helper.call('scheduled_document_append',{app:String(target.pid)},{ownerRunId:'recipe-owner',target,beforeDispatch:id=>{dispatchId=id;throw Error('parent persistence failed');}})).rejects.toMatchObject({noInputSent:true});
 expect(transport).not.toHaveBeenCalled();expect(f.records()).toEqual([expect.objectContaining({dispatchId,state:'unknown'})]);
 await f.helper.releaseRun('recipe-owner');
 await expect(f.helper.call('scheduled_document_save',{app:String(target.pid)},{ownerRunId:'different-owner',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});
 expect(transport).not.toHaveBeenCalled();expect(f.records()).toHaveLength(1);expect(f.helper.queryOperation(dispatchId)?.state).toBe('unknown');
});
it.each(['scheduled_document_append','scheduled_document_save'])('%s persists structured no-input rejection as native-result',async op=>{
 const f=fixture(),transport=vi.spyOn(f.helper as any,'transport').mockResolvedValue({status:'rejected',noInputSent:true,reasonCode:'native-precondition'});
 const result=await f.helper.call(op,{app:String(target.pid)},{ownerRunId:'recipe-owner',target}) as Record<string,unknown>;
 expect(result).toMatchObject({status:'rejected',noInputSent:true});expect(result.deliveryUnknown).toBeUndefined();
 expect(f.records()).toEqual([expect.objectContaining({op,state:'native-result',dispatchId:result.dispatchId})]);
 await f.helper.releaseRun('recipe-owner');
 await expect(f.helper.call(op,{app:String(target.pid)},{ownerRunId:'next-owner',target})).resolves.toMatchObject({status:'rejected',noInputSent:true});
 expect(transport).toHaveBeenCalledTimes(2);
});
