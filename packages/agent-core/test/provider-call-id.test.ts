import {expect,it,vi} from 'vitest';
import {runAgent} from '../src/agent.js';import {ToolRegistry} from '../src/tools.js';import {tasksFromEvents} from '../src/tasks.js';import type {AgentEvent} from '../src/events.js';import type {ChatModel,ToolCall} from '../src/provider.js';
const call=(text:string):ToolCall=>({id:'provider-reused-id',name:'synthetic_write',argumentsText:JSON.stringify({text})});
function model(turns:ToolCall[][]):ChatModel{let index=0;return {id:'test:provider-id',async chat(){return {text:index<turns.length?'':'Finished.',toolCalls:turns[index++]??[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};}
function setup(){const writes:string[]=[],events:AgentEvent[]=[],owners:{runId?:string;callId?:string}[]=[],approve=vi.fn(async()=>({kind:'approve' as const}));const tools=new ToolRegistry().register({name:'synthetic_write',description:'Synthetic in-memory write',parameters:{type:'object',properties:{text:{type:'string'}}},actionClass:'write-local',async run(args:{text:string},ctx){writes.push(args.text);owners.push({runId:ctx.runId,callId:ctx.callId});return 'saved '+args.text;}});return {writes,events,owners,approve,tools};}
it('stops before a second different write reuses an earlier provider ID and preserves the first receipt',async()=>{
 const f=setup();const result=await runAgent({goal:'Create synthetic notes',model:model([[call('first')],[call('second')]]),tools:f.tools,emit:event=>f.events.push(event),authorize:()=>({kind:'ask',reason:'approve synthetic'}),requestApproval:f.approve,maxSteps:4});
 expect(result.status).toBe('failed');expect(f.writes).toEqual(['first']);expect(f.approve).toHaveBeenCalledOnce();
 const finished=f.events.filter(event=>event.type==='tool.finished');expect(finished).toHaveLength(1);expect(finished[0]).toMatchObject({ok:true,output:'saved first'});
 const task=tasksFromEvents(f.events)[0]!;expect(task.operations).toHaveLength(1);expect(task.operations[0]).toMatchObject({callId:'provider-reused-id',status:'completed'});
 expect(result.messages.filter(message=>message.role==='assistant'&&message.toolCalls?.some(call=>call.id==='provider-reused-id'))).toHaveLength(1);
});
it('rejects duplicate provider IDs in the same batch before dispatching any member',async()=>{
 const f=setup();const result=await runAgent({goal:'Create synthetic notes',model:model([[call('first'),call('second')]]),tools:f.tools,emit:event=>f.events.push(event),requestApproval:f.approve,maxSteps:2});
 expect(result.status).toBe('failed');expect(f.writes).toEqual([]);expect(f.events.some(event=>event.type==='tool.proposed'||event.type==='tool.finished')).toBe(false);
});
it('does not reject an unrelated new run merely because its provider uses the same ID',async()=>{
 const f=setup();for(const runId of ['first-run','second-run'])await runAgent({runId,goal:'Create synthetic note',model:model([[call(runId)]]),tools:f.tools,emit:event=>f.events.push(event),authorize:()=>({kind:'allow'}),requestApproval:f.approve,maxSteps:2});
 expect(f.writes).toEqual(['first-run','second-run']);
 expect(f.owners).toEqual([{runId:'first-run',callId:'provider-reused-id'},{runId:'second-run',callId:'provider-reused-id'}]);
});
