import {it,expect} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import {tasksFromEvents,taskResumeContext} from '../src/tasks.js';
import type {AgentEvent} from '../src/events.js';
it('acknowledged draft is not repeated and final summary requires review',async()=>{
 let writes=0,turn=0;const events:AgentEvent[]=[];
 const tools=new ToolRegistry().register({name:'mail_draft',description:'draft',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async()=>{writes++;return 'Saved; independent readback unavailable. Do not repeat.';}});
 const model={id:'test',chat:async()=>({text:++turn>2?'All done':'',toolCalls:turn<=2?[{id:'c'+turn,name:'mail_draft',argumentsText:'{}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 const result=await runAgent({goal:'Prepare requested draft',tools,model,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),runId:'r',now:()=>1});
 expect(writes).toBe(1);expect(result.detail).not.toBe('All done');
 const task=tasksFromEvents(events)[0]!;expect(task.status).toBe('needs_review');
 turn=0;
 const resumed:AgentEvent[]=[];
 await runAgent({goal:task.goal,resumeTask:task,tools,model,emit:e=>resumed.push(e),requestApproval:async()=>({kind:'approve'}),runId:'r2',now:()=>2});
 expect(writes).toBe(1);expect(resumed.some(e=>e.type==='tool.finished'&&!e.ok&&e.output.includes('already has'))).toBe(true);
 const snapshot=JSON.parse(taskResumeContext(task));expect(snapshot.successful).toEqual([]);expect(snapshot.acknowledgedUnverified[0].doNotRepeat).toBe(true);
});
it('a receipt emitted before a tool failure cannot complete work',async()=>{
 const events:AgentEvent[]=[];let turn=0;const hash='a'.repeat(64);
 const tools=new ToolRegistry().register({name:'calendar_create',description:'create',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async(_a,ctx)=>{ctx.recordOutcomeEvidence?.({version:1,domain:'calendar',kind:'event-created',targetId:'synthetic',requestHash:hash,observedHash:hash,source:'controller-readback'});throw Error('Readback failed');}});
 const model={id:'test',chat:async()=>({text:++turn>1?'Stopped':'',toolCalls:turn===1?[{id:'c',name:'calendar_create',argumentsText:'{}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 await runAgent({goal:'Create requested event',tools,model,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),runId:'r',now:()=>1});
 const finished=events.find(e=>e.type==='tool.finished');expect(finished).toMatchObject({ok:false});expect(finished).not.toHaveProperty('outcomeEvidence');expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
});
