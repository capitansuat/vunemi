import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OperationJournal} from '../src/operation-journal.js';
it('preserves bounded native drag reason and phase durably without raw content and loads old rows',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-diagnostics-')),'journal.json'),j=new OperationJournal(path,512,()=>{}),old=j.prepare('background_press');j.transition(old.dispatchId,'dispatched');j.transition(old.dispatchId,'native-result',{status:'delivered'});
 const r=j.prepare('background_drag');j.transition(r.dispatchId,'dispatched');j.transition(r.dispatchId,'unknown',{status:'unknown',reasonCode:'environment-changed',phase:'move',message:'PRIVATE_PATH_AND_VALUE'});
 const restarted=new OperationJournal(path,512,()=>{});expect(restarted.query(r.dispatchId)).toMatchObject({nativeReasonCode:'environment-changed',nativePhase:'move',state:'unknown'});expect(restarted.query(old.dispatchId)?.nativeStatus).toBe('delivered');expect(readFileSync(path,'utf8')).not.toContain('PRIVATE');
});
it('does not persist arbitrary native diagnostic strings and rejects corrupted saved diagnostic fields',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'drag-diagnostics-')),'journal.json'),j=new OperationJournal(path,512,()=>{}),r=j.prepare('background_drag');j.transition(r.dispatchId,'dispatched');j.transition(r.dispatchId,'unknown',{status:'unknown',reasonCode:'PRIVATE_LABEL',phase:'PRIVATE_PATH'});expect(j.query(r.dispatchId)).not.toHaveProperty('nativeReasonCode');expect(j.query(r.dispatchId)).not.toHaveProperty('nativePhase');const saved=JSON.parse(readFileSync(path,'utf8'));saved.records[0].nativePhase='arbitrary';writeFileSync(path,JSON.stringify(saved));expect(()=>new OperationJournal(path,512,()=>{})).toThrow(/Invalid operation journal/);
});
