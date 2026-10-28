import {it,expect} from 'vitest';
import {runAgent} from '../src/agent.js';
import {tasksFromEvents,taskProgressTool,validateTaskProgress} from '../src/tasks.js';
import {ToolRegistry} from '../src/tools.js';
const task=()=>tasksFromEvents([{type:'run.started',runId:'old',goal:'Write /tmp/report.md',model:'local',at:1},{type:'tool.proposed',runId:'old',stepId:'s',callId:'saved',tool:'files_write',actionClass:'write-local',args:{}},{type:'tool.finished',runId:'old',callId:'saved',ok:true,output:'saved',produced:[{kind:'file',path:'/tmp/report.md'}],durationMs:1},{type:'run.finished',runId:'old',status:'stopped',detail:'cut',at:2}])[0]!;
it('blocks a repeated write before approval on explicit continuation',async()=>{
 let turn=0,writes=0,approvals=0;const tools=new ToolRegistry().register({name:'files_write',description:'write',actionClass:'write-local',parameters:{type:'object',properties:{}},run:async()=>{writes++;return 'saved';}});
 await runAgent({emit:()=>{},resumeTask:task(),goal:'Continue',tools,model:{id:'local',chat:async()=>({text:turn++?'Blocked':'',toolCalls:turn===1?[{id:'again',name:'files_write',argumentsText:'{"path":"/tmp/report.md","content":"same"}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})},requestApproval:async()=>{approvals++;return {kind:'approve'};}});
 expect(writes).toBe(0);expect(approvals).toBe(0);
});
it('accepts successful same-task historical receipts without redoing the action',()=>{
 const prior=task();prior.activeRunId='new';prior.runIds.push('new');prior.status='running';
 expect(()=>validateTaskProgress(prior,'new',{step:1,status:'completed',evidenceCallIds:['saved']})).not.toThrow();
 prior.operations[0]!.status='unknown';expect(()=>validateTaskProgress(prior,'new',{step:1,status:'completed',evidenceCallIds:['saved']})).toThrow();
});
it('requires recording a saved write before moving to another planned write',async()=>{
 const {pendingWriteProgress}=await import('../src/tasks.js');const t=task();t.planAccepted=true;t.steps.push({...t.steps[0]!,title:'next output'});
 expect(pendingWriteProgress(t)).toEqual(['saved']);
 t.steps[0]!.status='completed';t.steps[0]!.evidence='tool_result';t.steps[0]!.receipts=[{runId:'old',callId:'saved'}];
 expect(pendingWriteProgress(t)).toEqual([]);
});
it('shows only verification/progress tools until an earlier output is accounted for',async()=>{
 const t=task();t.planAccepted=true;t.steps.push({...t.steps[0]!,title:'next output'});let names:string[]=[];let context="";
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'files_write',description:'write',actionClass:'write-local',parameters:{type:'object',properties:{}},run:async()=> 'saved'}).register({name:'files_read',description:'read',actionClass:'read',parameters:{type:'object',properties:{}},run:async()=> 'contents'});
 await runAgent({emit:()=>{},resumeTask:t,goal:'Continue',tools,maxSteps:1,model:{id:'local',chat:async req=>{names=req.tools.map(t=>t.name);context=req.messages.at(-1)!.content;return {text:'Cannot finish',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}},requestApproval:async()=>({kind:'approve'})});
 expect(names).toContain('files_read');expect(names).toContain('task_update');expect(names).not.toContain('files_write');expect(context).toContain('Candidate progress calls');expect(context).toContain('saved');
});
it('uses the file tool canonical path to protect a relative alias of a saved output',async()=>{
 let turns=0,writes=0;const tools=new ToolRegistry().register({name:'files_write',description:'write',actionClass:'write-local',parameters:{type:'object',properties:{}},resolveFile:()=>'/tmp/report.md',run:async()=>{writes++;return 'saved';}});
 await runAgent({emit:()=>{},resumeTask:task(),goal:'Continue',tools,maxSteps:1,model:{id:'local',chat:async()=>({text:'',toolCalls:turns++?[]:[{name:'files_write',id:'alias',argumentsText:'{"path":"report.md","content":"same"}'}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})},requestApproval:async()=>({kind:'approve'})});expect(writes).toBe(0);
});
it('rejects an unsupported year on a generated file read even when its local model would accept it',async()=>{
 const events:import('../src/events.js').AgentEvent[]=[];
 const tools=new ToolRegistry().register({name:'files_read',description:'read',actionClass:'read',parameters:{type:'object',properties:{path:{type:'string'},checks:{type:'object'}}},resolveFile:()=>'/tmp/report.md',run:async()=> '# Rapor (Ocak-Haziran 2026)'});
 await runAgent({emit:e=>events.push(e),resumeTask:task(),goal:'Continue',tools,maxSteps:1,model:{id:'local',chat:async()=>({text:'',toolCalls:[{name:'files_read',id:'read',argumentsText:'{"path":"report.md","checks":{"contains":["Rapor"]}}'}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})},requestApproval:async()=>({kind:'approve'})});
 expect(events.find(e=>e.type==='tool.finished'&&e.callId==='read')).toMatchObject({ok:false,retryable:true});
});
