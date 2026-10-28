import {it,expect} from 'vitest';
import {tasksFromEvents} from '../src/tasks.js';
import {validOutcomeEvidence,outcomeFingerprint} from '../src/outcome-evidence.js';
const hash='a'.repeat(64);const proof={version:1 as const,domain:'calendar' as const,kind:'event-created' as const,targetId:'event-1',requestHash:hash,observedHash:hash,source:'controller-readback' as const};
function fold(tool:string,evidence?:unknown){return tasksFromEvents([
 {type:'run.started',runId:'r',goal:'Create the requested result',model:'test',at:1},
 {type:'plan.proposed',runId:'r',steps:['Create and verify result'],at:2},
 {type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['Create and verify result']},at:3},
 {type:'tool.proposed',runId:'r',stepId:'r.s0',callId:'c',tool,args:{},actionClass:'write-local'},
 {type:'tool.started',runId:'r',callId:'c',at:4},
 {type:'tool.finished',runId:'r',callId:'c',ok:true,output:'success',durationMs:1,...(evidence?{outcomeEvidence:evidence}:{})},
 {type:'task.progress',runId:'r',step:1,status:'completed',evidenceCallIds:['c'],at:5},
 {type:'run.finished',runId:'r',status:'done',detail:'Done',at:6},
 ]as any)[0]!;}
for(const tool of ['calendar_create','calendar_update','mail_draft','page_click','page_target_act','page_goto'])it(`${tool} acknowledgement cannot complete a task`,()=>{const task=fold(tool);expect(task.status).toBe('needs_review');expect(task.steps[0]!.status).not.toBe('completed');});
it('accepts exact typed readback but not a proof from another domain or mismatched state',()=>{expect(fold('calendar_create',proof).status).toBe('completed');expect(fold('mail_draft',proof).status).toBe('needs_review');expect(fold('calendar_create',{...proof,observedHash:'b'.repeat(64)}).status).toBe('needs_review');});
it('does not trust proof-shaped output text',()=>{const task=fold('calendar_create');expect(task.operations[0]).not.toHaveProperty('outcomeEvidence');});
it('keeps existing read work compatible',()=>{expect(fold('files_read').status).toBe('completed');});
it('canonical fingerprints preserve arrays but ignore object key insertion order',async()=>{expect(await outcomeFingerprint({b:2,a:1})).toBe(await outcomeFingerprint({a:1,b:2}));expect(await outcomeFingerprint(['a','b'])).not.toBe(await outcomeFingerprint(['b','a']));});
it('rejects forged/extra fields and wrong tool source',()=>{expect(validOutcomeEvidence(proof,'calendar_create')).toBe(true);expect(validOutcomeEvidence({...proof,verified:true},'calendar_create')).toBe(false);expect(validOutcomeEvidence(proof,'mail_draft')).toBe(false);});
it('deduplicates equivalent calendar and mail wire encodings',async()=>{
 const {mutationRequestFingerprint:f}=await import('../src/outcome-evidence.js');
 expect(await f('calendar_create',{title:'A',start:'2028-02-29T10:00Z',end:'2028-02-29T11:00Z'})).toBe(await f('calendar_create',{title:'A',start:'2028-02-29T10:00:00.000Z',end:'2028-02-29T11:00:00Z',allDay:false,location:'',notes:''}));
 expect(await f('mail_draft',{to:[' A@EXAMPLE.COM ', ''],subject:'A',body:'a\r\nb'})).toBe(await f('mail_draft',{to:['a@example.com'],cc:[],subject:'A',body:'a\nb'}));
 expect(await f('mail_draft',{to:['a@example.com'],subject:'A',body:'a'})).not.toBe(await f('mail_draft',{to:['a@example.com'],subject:'B',body:'a'}));
});
