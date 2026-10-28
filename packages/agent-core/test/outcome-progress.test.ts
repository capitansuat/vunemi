import {afterEach,expect,it} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {automaticOutcomeCompletions,isOutcomeWorkflowPlan,outcomeCallMatches,outcomeWorkflow} from '../src/outcome-progress.js';
import {tasksFromEvents,validateTaskProgress} from '../src/tasks.js';
import type {OutcomeEvidence} from '../src/outcome-evidence.js';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import type {AgentEvent} from '../src/events.js';
afterEach(()=>setLocale('tr'));
const goal='Open https://example.com/a and verify the page';
const hash='a'.repeat(64),proof:OutcomeEvidence={version:1,domain:'browser',kind:'navigation',targetId:'exact-target',requestHash:hash,observedHash:hash,source:'controller-readback'};
function task(tool='page_goto',args:Record<string,unknown>={url:'https://example.com/a'},evidence:OutcomeEvidence|undefined=proof){
 const workflow=outcomeWorkflow(goal)!;
 return tasksFromEvents([
  {type:'run.started',runId:'r',goal,model:'test',at:1},
  {type:'plan.proposed',runId:'r',steps:workflow.steps,at:2},
  {type:'plan.resolved',runId:'r',decision:{kind:'go',steps:workflow.steps},at:3},
  {type:'tool.proposed',runId:'r',stepId:'r.s0',callId:'work',tool,args,actionClass:'read'},
  {type:'tool.started',runId:'r',callId:'work',at:4},
  {type:'tool.finished',runId:'r',callId:'work',ok:true,output:'ack',durationMs:1,...(evidence?{outcomeEvidence:evidence}:{})},
 ]as any)[0]!;
}
it('loads Unicode-safe English and Turkish single-action grammars',()=>{
 for(const g of [goal,'https://example.com/a sayfasını aç ve başlığını doğrula.','Create a calendar event "Test" from 2028-02-29T10:00Z to 2028-02-29T11:00Z.','Takvime "Test" etkinliğini 2028-02-29T10:00Z ile 2028-02-29T11:00Z arasında ekle.','Save a draft to a@example.com with subject "Test" and body "Hello Ω".','a@example.com için konusu "Test", metni "Hello Ω" olan bir taslak kaydet.'])expect(outcomeWorkflow(g),g).not.toBeNull();
 for(const g of [goal+' Then send an email.','Open https://example.com/a and verify the page and pay','Save a draft to a@example.com with subject "Test" and body "Hello" and send it.'])expect(outcomeWorkflow(g)).toBeNull();
});
it.each(['2026-02-31T10:00Z','2026-02-29T10:00Z','2028-04-31T10:00Z','2028-00-10T10:00Z','2028-13-10T10:00Z','2028-01-00T10:00Z','2028-02-29T24:00Z','2028-02-29T10:60Z','2028-02-29T10:00:60Z','2028-02-29T10:00+24:00','2028-02-29T10:00+01:60'])('refuses invalid calendar instant %s without normalizing it',start=>{
 expect(outcomeWorkflow(`Create calendar event "Test" from ${start} to 2028-05-01T11:00Z`)).toBeNull();
});
it('accepts leap-day offsets and requires exact calendar title/time/default fields',()=>{
 const w=outcomeWorkflow('Create calendar event "Leap" from 2028-02-29T10:00:00.123+01:00 to 2028-02-29T11:00:00.123+01:00')!;expect(w).not.toBeNull();
 const args={title:'Leap',start:'2028-02-29T09:00:00.123Z',end:'2028-02-29T10:00:00.123Z'};
 expect(outcomeCallMatches(w,'calendar_create',args)).toBe(true);
 for(const change of [{title:'Wrong'},{start:'2028-03-01T09:00:00.123Z'},{allDay:true},{calendar:'Other'},{notes:'Extra'}])expect(outcomeCallMatches(w,'calendar_create',{...args,...change})).toBe(false);
 const normalized=outcomeWorkflow('Create calendar event "Test" from 2026-03-03T10:00Z to 2026-03-03T11:00Z')!;
 expect(outcomeCallMatches(normalized,'calendar_create',{title:'Test',start:'2026-02-31T10:00Z',end:'2026-03-03T11:00Z'})).toBe(false);
});
it('matches draft exact recipient/body and refuses expanded recipients or account scope',()=>{
 const w=outcomeWorkflow('Save a draft to a@example.com with subject "Test" and body "Exact text"')!;
 const args={to:['a@example.com'],subject:'Test',body:'Exact text'};expect(outcomeCallMatches(w,'mail_draft',args)).toBe(true);
 for(const change of [{to:['b@example.com']},{to:['a@example.com','b@example.com']},{body:'Wrong'},{cc:['b@example.com']},{account:'Other'}])expect(outcomeCallMatches(w,'mail_draft',{...args,...change})).toBe(false);
});
it('automatically completes only exact application-owned plan with current matching typed proof',()=>{
 const t=task();expect(isOutcomeWorkflowPlan(t)).toBe(true);expect(automaticOutcomeCompletions(t)).toEqual([{step:1,status:'completed',evidenceCallIds:['work']},{step:2,status:'completed',evidenceCallIds:['work']}]);
 t.operations[0]!.outcomeBound=false;expect(automaticOutcomeCompletions(t)).toEqual([]);
 t.operations[0]!.outcomeBound=true;t.operations[0]!.runId='old-run';expect(automaticOutcomeCompletions(t)).toEqual([]);
});
it('rejects manual completion using wrong URL proof or unrelated read receipt',()=>{
 for(const t of [task('page_goto',{url:'https://example.com/b'}),task('files_read',{path:'/fixture.txt'},undefined)]){
  expect(automaticOutcomeCompletions(t)).toEqual([]);
  for(const step of [1,2])expect(()=>validateTaskProgress(t,'r',{step,status:'completed',evidenceCallIds:['work']})).toThrow();
 }
});
it('fails closed for edited plans and locale changes, preserving existing step titles',()=>{
 setLocale('en');const t=task(),titles=t.steps.map(s=>s.title);
 setLocale('de');expect(isOutcomeWorkflowPlan(t)).toBe(false);expect(automaticOutcomeCompletions(t)).toEqual([]);expect(t.steps.map(s=>s.title)).toEqual(titles);
 setLocale('en');t.steps[0]!.title='User edited step';expect(isOutcomeWorkflowPlan(t)).toBe(false);expect(automaticOutcomeCompletions(t)).toEqual([]);
});
it('rejects manual wrong-target or unrelated receipts after locale change or plan editing',()=>{
 setLocale('en');
 for(const t of [task('files_read',{path:'/fixture.txt'}),task('page_goto',{url:'https://example.com/b'})]){
  setLocale('de');expect(()=>validateTaskProgress(t,'r',{step:1,status:'completed',evidenceCallIds:['work']})).toThrow();
  setLocale('en');t.steps[0]!.title='User edited step';expect(()=>validateTaskProgress(t,'r',{step:1,status:'completed',evidenceCallIds:['work']})).toThrow();
 }
});
it('never completes from acknowledgement-only or unknown delivery',()=>{
 const t=task();delete t.operations[0]!.outcomeEvidence;expect(automaticOutcomeCompletions(t)).toEqual([]);
 t.operations[0]!.outcomeEvidence=proof;t.operations.push({...t.operations[0]!,callId:'uncertain',status:'unknown'});expect(automaticOutcomeCompletions(t)).toEqual([]);
});
it('completes an accepted navigation workflow from real adapter callback without model task_update',async()=>{
 const events:AgentEvent[]=[];let turns=0,calls=0;
 const tools=new ToolRegistry().register({name:'page_goto',description:'Open URL',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']},actionClass:'read',run:async(args,ctx)=>{calls++;expect((args as {url:string}).url).toBe('https://example.com/a');ctx.recordOutcomeEvidence?.(proof);return 'Independent navigation readback';}});
 const model={id:'test',chat:async()=>({text:++turns===1?'':'Done',toolCalls:turns===1?[{id:'navigation',name:'page_goto',argumentsText:JSON.stringify({url:'https://example.com/a'})}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 const result=await runAgent({goal,tools,model,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'}),runId:'run',now:()=>1});
 const completed=tasksFromEvents(events)[0]!;expect(result.status).toBe('done');expect(calls).toBe(1);expect(completed.status).toBe('completed');
 expect(completed.steps.map(s=>({status:s.status,evidence:s.evidence,callId:s.receipts[0]?.callId}))).toEqual([{status:'completed',evidence:'tool_result',callId:'navigation'},{status:'completed',evidence:'tool_result',callId:'navigation'}]);
 expect(events.filter(e=>e.type==='task.progress')).toHaveLength(2);
});
