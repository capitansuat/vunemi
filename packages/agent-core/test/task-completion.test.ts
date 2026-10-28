import {t} from '@vunemi/i18n';
import { it, expect } from 'vitest';
import { runAgent, listedRequest } from '../src/agent.js';
import { ToolRegistry } from '../src/tools.js';
import { taskProgressTool, tasksFromEvents } from '../src/tasks.js';
import type { AgentEvent } from '../src/events.js';
import type { ChatModel, ChatRequest } from '../src/provider.js';

it('keeps progress available in an existing conversation tool list', () => {
 const tools = new ToolRegistry().register(taskProgressTool());
 expect(listedRequest(tools, [], new Set(['tool_run'])).tools.map(t => t.name)).toContain('task_update');
});
it('continues past prose approval and premature answers until output verification and progress', async () => {
 const events: AgentEvent[]=[]; const requests: ChatRequest[]=[]; let turn=0; let written=false; let approvals=0;
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_write', description:'write', parameters:{type:'object',properties:{}}, actionClass:'write-local',run:async (_a,c)=>{written=true;c.produced?.({kind:'file',path:'/tmp/report.md'});return 'written';}}).register({name:'files_read',description:'read',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=> written?'verified':'missing'});
 const turns=[{text:'Dosyayı yazmaya onaylıyor musunuz?'},{calls:[{id:'w',name:'files_write',argumentsText:'{"path":"/tmp/report.md","content":"report"}'}]},{text:'Şimdi dosyayı doğrulayayım:'},{calls:[{id:'v',name:'files_read',argumentsText:'{"path":"/tmp/report.md"}'}]},{calls:[{id:'p',name:'task_update',argumentsText:'{"step":1,"status":"completed","evidenceCallIds":["w","v"]}'}]},{text:'Report written and verified.'}];
 const model:ChatModel={id:'test',chat:async r=>{requests.push(r);const t=turns[turn++];if(!t)throw Error('exhausted');return {text:t.text??'',toolCalls:t.calls??[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 const result=await runAgent({model,tools,goal:'Write report.md and verify it',runId:'r',emit:e=>events.push(e),requestApproval:async()=>{approvals++;return {kind:'approve'};}});
 expect(result.status).toBe('done'); expect(approvals).toBe(1);expect(turn).toBe(5);expect(tasksFromEvents(events)[0]?.status).toBe('completed');
 expect(requests.some(r=>r.messages.some(m=>typeof m.content==='string'&&m.content.includes('unfinished')))).toBe(true);
});

it('fails honestly after bounded completion retries without repeating a write', async () => {
 let calls=0;let turns=0;const events:AgentEvent[]=[];
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_write',description:'write',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async()=>{calls++;return 'written';}});
 const model:ChatModel={id:'test',chat:async()=>({text:turns++ ? 'Done.' : '',toolCalls:turns===1?[{id:'w',name:'files_write',argumentsText:'{"path":"/tmp/report.md"}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 const result=await runAgent({model,tools,goal:'Write report.md',emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('failed');expect(calls).toBe(1);expect(turns).toBe(4);expect(tasksFromEvents(events)[0]?.status).toBe('failed');
});
it('keeps completion checks after a wrong tool name has been recovered', async () => {
 const events:AgentEvent[]=[];let turn=0;
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_read',description:'read',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=> 'verified'});
 const turns=[{calls:[{id:'bad',name:'read',argumentsText:'{}'}]},{calls:[{id:'v',name:'files_read',argumentsText:'{}'}]},{text:'Done.'},{calls:[{id:'p',name:'task_update',argumentsText:'{"step":1,"status":"completed","evidenceCallIds":["v"]}'}]},{text:'Verified.'}];
 const model:ChatModel={id:'test',chat:async()=>{const t=turns[turn++];if(!t)throw Error('exhausted');return {text:t.text??'',toolCalls:t.calls??[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 await runAgent({model,tools,goal:'Read and verify',emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(turn).toBe(5);expect(tasksFromEvents(events)[0]?.status).toBe('completed');
});
it('restores work tools from the original task when resuming a generic continue request', async () => {
 const previous=tasksFromEvents([{type:'run.started',runId:'old',goal:'Read report',model:'test',at:1},{type:'tool.proposed',runId:'old',stepId:'s',callId:'oldread',tool:'files_read',actionClass:'read',args:{}},{type:'tool.finished',runId:'old',callId:'oldread',ok:true,output:'read',durationMs:1},{type:'run.finished',runId:'old',status:'stopped',detail:'closed',at:2}])[0]!;
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_read',description:'read',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=> 'verified'},'files');
 const requests:ChatRequest[]=[];let turn=0;
 const model:ChatModel={id:'test',chat:async r=>{requests.push(r);return {text:'',toolCalls:turn++===0?[{id:'v',name:'files_read',argumentsText:'{}'}]:turn===2?[{id:'p',name:'task_update',argumentsText:'{"step":1,"status":"completed","evidenceCallIds":["v"]}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 await runAgent({model,tools,goal:'Continue where you left off.',resumeTask:previous,shownTools:new Set<string>(),areas:[{id:'files',summary:'Files'}],pickAreas:async()=>[],emit:()=>{},requestApproval:async()=>({kind:'approve'})});
 expect(requests[0]!.tools?.map(t=>t.name)).toContain('files_read');
});
it('tells the model that receipt-free completion is only reported, with available source receipts', async () => {
 const tool=taskProgressTool();const text=await tool.run({step:1,status:'completed',evidenceCallIds:[]},{signal:new AbortController().signal,handoff:async()=>false,offerUndo:()=>{},attach:()=>{},updateTask:async()=>{},taskReceipts:()=>[{tool:'files_read',callId:'source'}]});
 expect(text).toContain('reported');expect(text).toContain('source');expect(text).toContain('calculation');
});
it('continues after a correctable validation failure instead of accepting a promise to fix it',async()=>{
 let turn=0,writes=0;const events:AgentEvent[]=[];
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_write',description:'write',parameters:{type:'object',properties:{}},actionClass:'write-local',check:(a: {content?:string})=>a.content==='bad'?'Correct this unsupported value.':null,run:async(_a,c)=>{writes++;c.produced?.({kind:'file',path:'/tmp/report.md'});return 'saved';}}).register({name:'files_read',description:'read',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=> 'good'});
 const calls=[{name:'files_write',id:'bad',argumentsText:'{"path":"/tmp/report.md","content":"bad"}'},null,{name:'files_write',id:'saved',argumentsText:'{"path":"/tmp/report.md","content":"good"}'},{name:'files_read',id:'checked',argumentsText:'{"path":"/tmp/report.md"}'},{name:'task_update',id:'progress',argumentsText:'{"step":1,"status":"completed","evidenceCallIds":["saved","checked"]}'}];
 const result=await runAgent({emit:e=>events.push(e),goal:'Write report and verify it',tools,maxSteps:5,model:{id:'local',chat:async()=>{const c=calls[turn++];return {text:c?'':'I will fix it.',toolCalls:c?[c]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}},requestApproval:async()=>({kind:'approve'})});
 expect(writes).toBe(1);expect(result.detail).toBe(t('agent.deliveryVerifiedOne'));
});
