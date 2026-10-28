vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDesktopTools} from '../src/tools.js';
import {Helper} from '../src/helper.js';
import {OperationJournal} from '../src/operation-journal.js';
const target={bundleId:'com.apple.TextEdit',pid:123,processStartedAt:100,windowId:9};
const owner={ownerRunId:'run-test',target};
const path=()=>join(mkdtempSync(join(tmpdir(),'vunemi-journal-')),'operations.json');
describe('durable background dispatch journal',()=>{
 it('recovers dispatched operations as unknown and never stores payload',()=>{const p=path(),j=new OperationJournal(p,512,()=>{});const r=j.prepare('background_set_value');j.transition(r.dispatchId,'dispatched');const reopened=new OperationJournal(p,512,()=>{});reopened.quarantine();expect(reopened.query(r.dispatchId)?.state).toBe('unknown');expect(readFileSync(p,'utf8')).not.toContain('text');expect(statSync(p).mode&0o777).toBe(0o600);});
 it('preserves native receipt without certifying independent effect',()=>{const p=path(),j=new OperationJournal(p,512,()=>{}),r=j.prepare('background_save_document');j.transition(r.dispatchId,'dispatched');j.transition(r.dispatchId,'native-result',{status:'saved',operationId:'native-1'});expect(new OperationJournal(p,512,()=>{}).query(r.dispatchId)).toMatchObject({state:'native-result',nativeStatus:'saved',nativeOperationId:'native-1'});});
 it('fails closed on corrupt persistence',()=>{const p=path();writeFileSync(p,'{}');expect(()=>new OperationJournal(p,512,()=>{}).prepare('background_press')).toThrow();});
 it('blocks dispatch when the journal directory is unwritable',async()=>{const p=path();writeFileSync(p,'blocking file');const h=new Helper(process.execPath,{operationJournalPath:join(p,'child.json')}),transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport');await expect(h.call('background_press',{app:'123'},owner)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();});
 it('does not let callers mutate a queried record',()=>{const j=new OperationJournal(path(),512,()=>{}),r=j.prepare('background_press');r.state='unknown';expect(j.query(r.dispatchId)?.state).toBe('prepared');});
 it('bounds retention and refuses when outstanding operations fill capacity',()=>{const j=new OperationJournal(path(),2,()=>{});j.prepare('background_press');j.prepare('background_press');expect(()=>j.prepare('background_press')).toThrow(/capacity/);});
});

describe('production Helper dispatch boundary',()=>{
 it('persists before dispatch and correlates receipt',async()=>{const p=path(),h=new Helper(process.execPath,{operationJournalPath:p});const transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport').mockImplementation(async()=>{const data=JSON.parse(readFileSync(p,'utf8'));expect(data.records[0].state).toBe('dispatched');return {status:'verified',operationId:'native-id',text:'secret document'};});const r=await h.call('background_set_value',{app:'123',text:'secret document'},owner) as {dispatchId:string};expect(h.queryOperation(r.dispatchId)?.state).toBe('native-result');expect(readFileSync(p,'utf8')).not.toContain('secret');expect(transport).toHaveBeenCalledTimes(1);});
 it.each(['timeout','partial','unknown'])('keeps %s uncertain across restart without redispatch',async(mode)=>{const p=path(),h=new Helper(process.execPath,{operationJournalPath:p});const transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport');if(mode==='timeout')transport.mockRejectedValue(Error('timeout'));else transport.mockResolvedValue({status:mode});let id:string;if(mode==='timeout'){try{await h.call('background_press',{app:'123'},owner);throw Error('expected rejection');}catch(e){id=(e as {dispatchId:string}).dispatchId;}}else id=(await h.call('background_press',{app:'123'},owner) as {dispatchId:string}).dispatchId;expect(new Helper(process.execPath,{operationJournalPath:p}).queryOperation(id)?.state).toBe('unknown');expect(transport).toHaveBeenCalledTimes(1);});
 it('fails closed without persistence before transport',async()=>{const h=new Helper(process.execPath),transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport');await expect(h.call('background_press',{app:'123'},owner)).rejects.toMatchObject({reasonCode:'journal-unavailable',noInputSent:true});expect(transport).not.toHaveBeenCalled();});
});

describe('operation receipt query tool',()=>{
 it('reads receipt with no native transport or replay',async()=>{const p=path(),h=new Helper(process.execPath,{operationJournalPath:p}),j=new OperationJournal(p,512,()=>{}),record=j.prepare('background_press');j.transition(record.dispatchId,'dispatched');const transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport');const tool=createDesktopTools({helper:h}).find(t=>t.name==='desktop_operation_status')!;expect(tool.actionClass).toBe('read');const output=await tool.run({dispatchId:record.dispatchId},{signal:new AbortController().signal} as never) as string;expect(JSON.parse(output)).toMatchObject({record:{state:'dispatched'},sideEffectVerified:false});expect(transport).not.toHaveBeenCalled();});
 it('rejects invalid identity without native call',async()=>{const h=new Helper(process.execPath),transport=vi.spyOn(h as unknown as {transport:(op:string)=>Promise<unknown>},'transport');const tool=createDesktopTools({helper:h}).find(t=>t.name==='desktop_operation_status')!;await expect(tool.run({dispatchId:'forged'},{signal:new AbortController().signal} as never)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();});
});
