import { it, expect } from 'vitest';
import { runAgent } from '../src/agent.js';
import { ToolRegistry } from '../src/tools.js';
import { taskProgressTool, tasksFromEvents } from '../src/tasks.js';
import type { AgentEvent } from '../src/events.js';
import type { ChatModel, ChatRequest } from '../src/provider.js';

const goal='/tmp/source.csv dosyasını oku. /tmp/report.md dosyasına satış ve maliyeti yaz. /tmp/summary.txt dosyasına satış ve maliyeti yaz. Her çıktıyı doğrula.';
function fixture() {
 const files=new Map([['/tmp/source.csv','sales:650 cost:390']]);
 const tools=new ToolRegistry().register(taskProgressTool());
 tools.register<{path:string;checks?:unknown}>({name:'files_read',description:'read',parameters:{type:'object',properties:{path:{type:'string'},checks:{type:'object'}}},actionClass:'read',run:async a=>files.get(a.path) ?? 'missing'},'files:read');
 tools.register<{path:string;content:string}>({name:'files_write',description:'write',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}}},actionClass:'write-local',run:async(a,ctx)=>{files.set(a.path,a.content);ctx.produced?.({kind:'file',path:a.path});return 'saved';}},'files:write');
 return {files,tools};
}
function model(turns: ({name:string;args:unknown}|string)[],prefix='') {
 const requests:ChatRequest[]=[];let i=0;
 const model:ChatModel={id:'fake:auto-progress',cacheStableTools:true,chat:async req=>{
  if(req.signal?.aborted)throw req.signal.reason ?? new DOMException('Stopped','AbortError');
  requests.push(req);const turn=turns[i++];if(turn===undefined)throw Error('Unnecessary model turn');
  return {text:typeof turn==='string'?turn:'',toolCalls:typeof turn==='string'?[]:[{id:prefix+'c'+i,name:turn.name,argumentsText:JSON.stringify(turn.args)}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};
 }};return {model,requests};
}
const read=(path:string,checked=false)=>({name:'files_read',args:{path,...(checked?{checks:{contains:['650','390']}}:{})}});
const write=(path:string)=>({name:'files_write',args:{path,content:'sales:650 cost:390'}});
const review='{"ok":true,"issues":[]}';
const profile={areas:[{id:'files',summary:'files'}],shownTools:new Set<string>(),pickAreas:async()=>['files'],compactTaskTools:true,chatInstructions:'personal'};

it('completes source and verified output steps without model progress calls, retaining two approvals',async()=>{
 const {tools,files}=fixture();const {model:provider,requests}=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review,write('/tmp/summary.txt'),read('/tmp/summary.txt',true),review]);const events:AgentEvent[]=[];
 const result=await runAgent({goal,tools,model:provider,...profile,maxSteps:7,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(tasksFromEvents(events)[0]?.status).toBe('completed');
 expect(tasksFromEvents(events)[0]?.steps.map(s=>s.status)).toEqual(['completed','completed','completed']);
 expect(events.filter(e=>e.type==='approval.resolved').map(e=>e.decision.kind)).toEqual(['approve','approve']);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='task_update')).toHaveLength(0);
 expect(requests.filter(r=>r.tools.length).every(r=>!r.tools.some(t=>t.name==='task_update'))).toBe(true);
 expect(files.get('/tmp/summary.txt')).toBe('sales:650 cost:390');
});

it('completes the original task after Stop interrupts a generated output read',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true)]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='tool.started'&&e.callId==='c4')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;expect(task.status).toBe('interrupted');expect(task.operations.some(o=>o.tool==='files_read'&&o.status==='unknown')).toBe(true);
 const resumed=model([read('/tmp/report.md',true),review,write('/tmp/summary.txt'),read('/tmp/summary.txt',true),review],'resumed-');
 const result=await runAgent({goal:'Devam et.',tools,model:resumed.model,history:initial.messages,resumeTask:task,askBeyondRead:true,maxSteps:5,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(tasksFromEvents(events)[0]!.status).toBe('completed');
 expect(tasksFromEvents(events)).toHaveLength(1);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_write')).toHaveLength(2);
 expect(events.filter(e=>e.type==='approval.resolved').map(e=>e.decision.kind)).toEqual(['approve','approve']);
});

it('resumes a saved unverified output without repeating its write or reusing its approval',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md')]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:5,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.ok&&e.produced?.length)stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;expect(task.steps[1]?.status).not.toBe('completed');
 const resumed=model([read('/tmp/report.md',true),review,write('/tmp/summary.txt'),read('/tmp/summary.txt',true),review]);
 const result=await runAgent({goal:'Continue',tools,model:resumed.model,history:initial.messages,resumeTask:task,maxSteps:5,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(tasksFromEvents(events)[0]?.status).toBe('completed');
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_write')).toHaveLength(2);
 expect(events.filter(e=>e.type==='approval.resolved')).toHaveLength(2);
 const completed=events.filter(e=>e.type==='task.progress'&&e.status==='completed');expect(completed).toHaveLength(3);
 expect(completed.every(e=>e.type==='task.progress'&&e.evidenceCallIds.length>0)).toBe(true);
});

it('keeps a saved output pending when independent review rejects its actual contents',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),'{"ok":false,"issues":["wrong total"]}']);
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:3,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(tasksFromEvents(events)[0]!.steps.map(s=>s.status)).toEqual(['completed','working','pending']);
 expect(events.some(e=>e.type==='tool.finished'&&!e.ok&&e.output.includes('wrong total'))).toBe(true);
});

it('keeps a rejected write incomplete and never turns approval into completion',async()=>{
 const {tools,files}=fixture();const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md')]);
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:2,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'reject'})});
 expect(files.has('/tmp/report.md')).toBe(false);
 expect(tasksFromEvents(events)[0]!.steps.map(s=>s.status)).toEqual(['completed','pending','pending']);
});

it('leaves user-edited compound steps to explicit progress tracking',async()=>{
 const {tools}=fixture();const provider=model(['NONE',read('/tmp/source.csv')]);const events:AgentEvent[]=[];
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:1,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),requestPlanApproval:async()=>({kind:'go',steps:['Read and analyse both sources','Prepare report.md','Prepare summary.txt']})});
 expect(tasksFromEvents(events)[0]!.steps.every(s=>s.status==='pending')).toBe(true);
 expect(provider.requests[1]!.tools.some(t=>t.name==='task_update')).toBe(true);
});

it('does not complete a multi-source step after reading only the first requested source',async()=>{
 const {tools}=fixture();const provider=model(['NONE',read('/tmp/source.csv')]);const events:AgentEvent[]=[];
 await runAgent({goal:'/tmp/second.csv dosyasını oku. '+goal,tools,model:provider.model,...profile,maxSteps:1,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),requestPlanApproval:async steps=>({kind:'go',steps})});
 expect(tasksFromEvents(events)[0]!.steps[0]!.status).toBe('working');
 expect(tasksFromEvents(events)[0]!.steps[0]!.evidence).toBe('none');
});

it('does not complete an output from an unchecked read',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md')]);
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),requestPlanApproval:async steps=>({kind:'go',steps})});
 expect(tasksFromEvents(events)[0]!.steps.map(s=>s.status)).toEqual(['completed','working','pending']);
 expect(events.some(e=>e.type==='tool.finished'&&e.fileEvidence?.kind==='verified-read')).toBe(false);
});

it('reopens a completed output step when its verified contents are edited',async()=>{
 const {tools,files}=fixture();const events:AgentEvent[]=[];
 tools.register<{path:string;new_text:string}>({name:'files_edit',description:'edit',parameters:{type:'object',properties:{path:{type:'string'},new_text:{type:'string'}}},actionClass:'write-local',run:async a=>{files.set(a.path,a.new_text);return 'edited';}},'files:write');
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review,{name:'files_edit',args:{path:'/tmp/report.md',new_text:'sales:651 cost:390'}}]);
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:4,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'}),requestPlanApproval:async steps=>({kind:'go',steps})});
 expect(events.some(e=>e.type==='task.progress'&&e.step===2&&e.status==='completed')).toBe(true);
 expect(tasksFromEvents(events)[0]!.steps[1]!.status).toBe('working');
 expect(tasksFromEvents(events)[0]!.steps[1]!.evidence).toBe('none');
});


it('preflights saved verified outputs and fresh sources before the resumed executor, with a fresh write approval',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;
 const resumed=model([write('/tmp/summary.txt'),read('/tmp/summary.txt',true),review],'preflight-');
 const history=[...initial.messages,{role:'assistant' as const,content:'obsolete narration '.repeat(2000)}];
 let areaPicks=0;
 const result=await runAgent({goal:'Devam et.',tools,model:resumed.model,history,resumeTask:task,askBeyondRead:true,...profile,pickAreas:async()=>{areaPicks++;return ['files'];},maxSteps:4,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');
 expect(resumed.requests.filter(r=>!r.tools.length)).toHaveLength(1);
 expect(events.some(e=>e.type==='tool.finished'&&e.runId===result.runId&&e.fileEvidence?.review?.mode==='reused')).toBe(true);
 const executor=resumed.requests.find(r=>r.tools.length)!;
 expect(areaPicks).toBe(0);
 expect(executor.messages.some(m=>m.content.includes('obsolete narration'))).toBe(false);
 expect(executor.messages[0]!.content).toContain('completing multi-step file work locally');
 // Old writes and failed attempts remain in checkpoints, not in the executor prompt.
 expect(executor.messages.some(m=>m.role==='assistant'&&m.toolCalls?.some(c=>c.name==='files_write'&&c.argumentsText.includes('/tmp/report.md')))).toBe(false);
 expect(executor.messages.some(m=>m.content.includes('sales:650 cost:390'))).toBe(true);
 expect(executor.messages.some(m=>m.content.includes(goal))).toBe(true);
 expect(result.messages.some(m=>m.role==='assistant'&&m.toolCalls?.some(c=>c.name==='files_write'&&c.argumentsText.includes('/tmp/report.md')))).toBe(true);
 const fresh=events.filter(e=>e.runId===result.runId);
 expect(fresh.filter(e=>e.type==='tool.proposed').map(e=>e.type==='tool.proposed'?e.tool:'')).toEqual(['files_read','files_read','files_write','files_read']);
 expect(tasksFromEvents(events)[0]!.steps.map(s=>s.status)).toEqual(['completed','completed','completed']);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_write')).toHaveLength(2);
 expect(events.filter(e=>e.type==='approval.resolved').map(e=>e.decision.kind)).toEqual(['approve','approve']);
});


it('does not certify a saved output when preflight independent review rejects changed source data',async()=>{
 const {tools,files}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 files.set('/tmp/source.csv','sales:700 cost:400');
 const resumed=model(['{"ok":false,"issues":["source changed"]}'],'changed-');
 await runAgent({goal:'Devam et.',tools,model:resumed.model,history:initial.messages,resumeTask:tasksFromEvents(events)[0],...profile,maxSteps:0,requestApproval:async()=>({kind:"reject"}),emit:e=>events.push(e)});
 expect(events.some(e=>e.type==='tool.finished'&&!e.ok&&e.output.includes('source changed'))).toBe(true);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_write')).toHaveLength(1);
 expect(files.has('/tmp/summary.txt')).toBe(false);
 expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
});

it('rechecks source authorization before resume preflight and does not reuse a read grant',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const start=events.length;
 await runAgent({goal:'Devam et.',tools,model:model([]).model,history:initial.messages,resumeTask:tasksFromEvents(events)[0],...profile,maxSteps:0,requestApproval:async()=>({kind:"reject"}),emit:e=>events.push(e),authorize:async()=>({kind:'deny',reason:'Read access revoked'})});
 expect(events.slice(start).filter(e=>e.type==='tool.started')).toHaveLength(0);
 expect(events.slice(start).some(e=>e.type==='tool.finished'&&!e.ok)).toBe(true);
 expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
});


it('does not reuse ambiguous legacy check history for a resumed output',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;for(const operation of task.operations)if(operation.fileEvidence)delete operation.fileEvidence.checks;
 const history=[...initial.messages,{role:'assistant' as const,content:'',toolCalls:[{id:'c4',name:'files_read',argumentsText:JSON.stringify({path:'/tmp/report.md',checks:{contains:['wrong']}})}]}];
 const fresh:AgentEvent[]=[];
 await runAgent({goal:'Devam et.',tools,model:model([]).model,history,resumeTask:task,...profile,maxSteps:0,emit:e=>fresh.push(e),requestApproval:async()=>({kind:'reject'})});
 expect(fresh.filter(e=>e.type==='tool.proposed')).toHaveLength(0);
});


it('retains full recovery history for an uncertain write even after fresh checked reads',async()=>{
 const {tools}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;
 task.operations.push({runId:task.activeRunId,callId:'uncertain',tool:'files_write',actionClass:'write-local',status:'unknown',filePath:'/tmp/summary.txt'});
 const history=[...initial.messages,{role:'assistant' as const,content:'Uncertain operation details must remain.'}];
 const resumed=model([review,'Cannot establish the uncertain write.'],'uncertain-');
 await runAgent({goal:'Devam et.',tools,model:resumed.model,history,resumeTask:task,...profile,maxSteps:1,emit:e=>events.push(e),requestApproval:async()=>({kind:'reject'})});
 expect(resumed.requests.find(r=>r.tools.length)!.messages.some(m=>m.content.includes('Uncertain operation details must remain.'))).toBe(true);
});

it.each(['output','checks','legacy','reviewer','rule-version','instructions'] as const)('requires a new independent review after %s changes',async change=>{
 const {tools,files}=fixture();const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,signal:stop.signal,maxSteps:6,emit:e=>{events.push(e);if(e.type==='task.progress'&&e.step===2&&e.status==='completed')stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;const receipt=task.operations.findLast(o=>o.fileEvidence?.kind==='verified-read')!;
 expect(receipt.fileEvidence?.review?.mode).toBe('independent');
 if(change==='output')files.set('/tmp/report.md','sales:650 cost:390; changed content');
 if(change==='checks')receipt.fileEvidence!.checks={contains:['650']};
 if(change==='legacy')delete receipt.fileEvidence!.review;
 if(change==='rule-version')receipt.fileEvidence!.review!.version=0 as never;
 const resumed=model([review],'fresh-review-');const provider=change==='reviewer'?{...resumed.model,id:'fake:other-reviewer'}:resumed.model;const stopResume=new AbortController();
 await runAgent({goal:'Devam et.',tools,model:provider,resumeTask:task,history:[...initial.messages,...(change==='instructions'?[{role:'user' as const,content:'<user_request>\nAlso check the product names explicitly.\n</user_request>'}]:[])],...profile,signal:stopResume.signal,maxSteps:0,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.fileEvidence?.kind==='verified-read')stopResume.abort();},requestApproval:async()=>({kind:'reject'})});
 expect(resumed.requests).toHaveLength(1);expect(resumed.requests[0]!.tools).toHaveLength(0);
 if(change==='instructions')expect(resumed.requests[0]!.messages[1]!.content).toContain('Also check the product names explicitly.');
 expect(events.filter(e=>e.type==='tool.finished'&&e.fileEvidence?.review?.mode==='reused')).toHaveLength(0);
});

it('does not certify an output against truncated source content',async()=>{
 const {tools,files}=fixture();files.set('/tmp/source.csv','sales:650 cost:390\n'+'x'.repeat(120_000));const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),read('/tmp/report.md',true),review]);
 await runAgent({goal,tools,model:provider.model,...profile,maxSteps:3,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(events.some(e=>e.type==='tool.finished'&&!e.ok&&e.output.includes('complete source text'))).toBe(true);
 expect(events.some(e=>e.type==='tool.finished'&&e.fileEvidence?.kind==='verified-read')).toBe(false);
});

function enableControllerChecks(tools:ToolRegistry) {
 const reader=tools.getAny('files_read')!;
 reader.parameters.properties!.checks={type:'object',properties:{nonempty:{type:'boolean'}}};
}
it('directly reads and independently checks each saved output without an executor verification turn',async()=>{
 const {tools}=fixture();enableControllerChecks(tools);const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),review,write('/tmp/summary.txt'),review]);
 const result=await runAgent({goal,tools,model:provider.model,...profile,automaticOutputChecks:true,maxSteps:3,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(tasksFromEvents(events)[0]!.steps.every(s=>s.status==='completed')).toBe(true);
 expect(provider.requests.filter(r=>r.tools.length)).toHaveLength(3);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_read'&&e.stepId.includes('.verify'))).toHaveLength(2);
 expect(events.filter(e=>e.type==='tool.finished'&&e.fileEvidence?.kind==='verified-read')).toHaveLength(2);
 expect(events.filter(e=>e.type==='approval.resolved').map(e=>e.decision.kind)).toEqual(['approve','approve']);
});
it('keeps the next write blocked after a controller output review fails',async()=>{
 const {tools,files}=fixture();enableControllerChecks(tools);const events:AgentEvent[]=[];
 const provider=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md'),'{"ok":false,"issues":["incorrect total"]}',write('/tmp/summary.txt')]);
 await runAgent({goal,tools,model:provider.model,...profile,automaticOutputChecks:true,maxSteps:3,emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(files.has('/tmp/summary.txt')).toBe(false);
 expect(events.some(e=>e.type==='tool.finished'&&!e.ok&&e.output.includes('incorrect total'))).toBe(true);
 expect(tasksFromEvents(events)[0]!.steps[1]!.status).not.toBe('completed');
});
it('reobserves a saved output after Stop interrupted its controller read without rewriting it',async()=>{
 const {tools}=fixture();enableControllerChecks(tools);const events:AgentEvent[]=[];const stop=new AbortController();
 const first=model(['NONE',read('/tmp/source.csv'),write('/tmp/report.md')]);
 const initial=await runAgent({goal,tools,model:first.model,...profile,automaticOutputChecks:true,signal:stop.signal,maxSteps:4,emit:e=>{events.push(e);if(e.type==='tool.started'&&e.callId.endsWith('.verify'))stop.abort();},requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'})});
 expect(initial.status).toBe('stopped');const resumed=model([review,write('/tmp/summary.txt'),review],'controller-resume-');
 const result=await runAgent({goal:'Devam et.',tools,model:resumed.model,...profile,automaticOutputChecks:true,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:2,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='files_write')).toHaveLength(2);
 expect(tasksFromEvents(events)[0]!.steps.every(s=>s.status==='completed')).toBe(true);
});
