import { afterEach, expect, it } from 'vitest';
import { getLocale, setLocale } from '@vunemi/i18n';
import { completedDelivery } from '../src/delivery.js';
import { runAgent } from '../src/agent.js';
import { taskProgressTool, tasksFromEvents } from '../src/tasks.js';
import { ToolRegistry } from '../src/tools.js';
import type { AgentEvent } from '../src/events.js';
import type { ChatModel } from '../src/provider.js';

const initialLocale=getLocale();
afterEach(()=>setLocale(initialLocale));

it('finishes verified file delivery with one short factual response, without asking the model to start again', async () => {
 setLocale('en');
 const events:AgentEvent[]=[];let turns=0;
 const tools=new ToolRegistry().register(taskProgressTool())
 .register({name:'files_write',description:'write',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async(_a,c)=>{c.produced?.({kind:'file',path:'/tmp/report.md'});return 'saved';}})
 .register({name:'files_read',description:'read',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=> 'report contents'});
 const calls=[{id:'w',name:'files_write',argumentsText:'{"path":"/tmp/report.md"}'},{id:'v',name:'files_read',argumentsText:'{"path":"/tmp/report.md"}'},{id:'p',name:'task_update',argumentsText:'{"step":1,"status":"completed","evidenceCallIds":["w","v"]}'}];
 const model:ChatModel={id:'local:test',chat:async()=>{const call=calls[turns++];if(!call)throw Error('The finished task should not request another model answer');return {text:'',toolCalls:[call],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 const result=await runAgent({model,tools,goal:'Write report and check its contents',maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(turns).toBe(3);
 expect(result.detail).toBe('Saved 1 file and checked its contents.');
 expect(events.filter(e=>e.type==='message.delta').map(e=>e.text)).toEqual([result.detail]);
 expect(result.messages.at(-1)).toMatchObject({role:'assistant',content:result.detail});
 expect(tasksFromEvents(events)[0]?.status).toBe('completed');
});

function readyTask() {
 return tasksFromEvents([
  {type:'run.started',runId:'r',model:'local',goal:'Save report',at:1},
  {type:'tool.proposed',runId:'r',stepId:'s',callId:'w',tool:'files_write',actionClass:'write-local',args:{}},
  {type:'tool.finished',runId:'r',callId:'w',ok:true,output:'saved',produced:[{kind:'file',path:'/tmp/report.md'}],durationMs:1},
  {type:'task.progress',runId:'r',step:1,status:'completed',evidenceCallIds:['w'],at:2},
 ])[0]!;
}
it('does not claim a content check for an unread output or repeat file names',()=>{
 setLocale('en');const task=readyTask();task.outputs.push({kind:'file',path:'/tmp/summary.txt'});
 expect(completedDelivery(task,new Set(['/tmp/report.md']))).toBe('Saved 2 files.');
 expect(completedDelivery(task,new Set(['/tmp/report.md','/tmp/summary.txt']))).toBe('Saved 2 files and checked their contents.');
});
it('does not replace partial, uncertain, or research answers with a delivery claim',()=>{
 const task=readyTask();task.steps[0]!.evidence='reported';expect(completedDelivery(task,new Set())).toBeNull();
 task.steps[0]!.evidence='tool_result';task.operations[0]!.status='unknown';expect(completedDelivery(task,new Set())).toBeNull();
 task.operations[0]!.status='completed';task.operations[0]!.actionClass='read';expect(completedDelivery(task,new Set())).toBeNull();
});
it('uses the application language for the concise closing',()=>{
 setLocale('tr');expect(completedDelivery(readyTask(),new Set(['/tmp/report.md']))).toBe('1 dosya kaydedildi ve içeriği kontrol edildi.');
});
