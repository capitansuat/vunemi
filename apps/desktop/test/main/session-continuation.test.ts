import { expect, it, vi, beforeEach } from 'vitest';
import { tasksFromEvents, type AgentEvent, type RunOptions, type TaskRecord } from '@vunemi/agent-core';
const received:RunOptions[]=[];
vi.mock('@vunemi/agent-core',async original=>{
 const real=await original<typeof import('@vunemi/agent-core')>();
 return {...real,createModel:(id:string)=>({id,contextWindow:async()=>20_000}),runAgent:async(opts:RunOptions)=>{
  received.push(opts);return {runId:'new',status:'stopped',detail:'',messages:[]};
 }};
});
const {AgentSession}=await import('../../src/main/session.js');
function stopped():TaskRecord {
 const events:AgentEvent[]=[
  {type:'run.started',runId:'old',goal:'Create two reports',model:'local',at:1},
  {type:'plan.proposed',runId:'old',steps:['Read source','Write report','Write summary'],at:2},
  {type:'plan.resolved',runId:'old',decision:{kind:'go',steps:['Read source','Write report','Write summary']}},
  {type:'run.finished',runId:'old',status:'stopped',detail:'',at:3},
 ];return tasksFromEvents(events)[0]!;
}
function session(task:TaskRecord|undefined=stopped()) {
 return new AgentSession({tools:{list:()=>[],get:()=>undefined} as never,emit:()=>{},authorize:async()=>({kind:'allow'}),onUntrustedOutput:()=>{},grants:new Set(['files_write']),latestTask:()=>task} as ConstructorParameters<typeof AgentSession>[0]);
}
beforeEach(()=>received.splice(0));
it.each(['Devam et.','devam et','Kaldığın yerden devam et!','Continue','Resume.'])('routes the exact continuation %s into the same stopped task with fresh approval',async text=>{
 const task=stopped();await session(task).start(text,'local');
 expect(received[0]?.resumeTask?.id).toBe('old');expect(received[0]?.askBeyondRead).toBe(true);
 expect(received[0]?.goal).toBe(text);expect(task.runIds).toEqual(['old']);
});
it.each(['Devam et ve raporu İngilizce yaz','Continue with a new report','Devam et ne demek?'])('keeps changed or quoted work as a new request: %s',async text=>{
 await session().start(text,'local');expect(received[0]?.resumeTask).toBeUndefined();
});
it.each(['completed','finished','running','waiting_approval'] as const)('does not resume the latest task in status %s',async status=>{
 const task=stopped();task.status=status;await session(task).start('Devam et.','local');expect(received[0]?.resumeTask).toBeUndefined();
});
it('does not resume a plan the user cancelled before any work',async()=>{
 const task=stopped();task.planAccepted=false;await session(task).start('Devam et.','local');expect(received[0]?.resumeTask).toBeUndefined();
});
it('does not turn a new attachment into continuation of the old task',async()=>{
 await session().start('Devam et.','local',['/tmp/new.csv']);expect(received[0]?.resumeTask).toBeUndefined();
});
it('does not implicitly resume in unattended runs',async()=>{
 await session().start('Devam et.','local',[],{unattended:true});expect(received[0]?.resumeTask).toBeUndefined();
});
