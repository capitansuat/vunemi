import {it,expect} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import {taskProgressTool,tasksFromEvents} from '../src/tasks.js';
import {createHash} from 'node:crypto';
import type {AgentEvent} from '../src/events.js';
import type {ChatModel,ChatRequest} from '../src/provider.js';
const goal='TextEdit içinde açık demo.txt belgesinin mevcut metnini koruyarak arka planda sonuna "İstanbul 👩‍💻." ekle. Yalnız desktop_background_append_text ile yeni metni bir kez ekle; gerçek alan değerini doğrula.';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const identity={version:1 as const,bundleId:'com.apple.TextEdit',processStartedAt:100,windowId:9,windowTitle:'demo.txt',fieldRef:1};
function fixture(options:{untyped?:boolean;wrongTarget?:boolean;uncertain?:boolean}={}){
 let value='old\n';let windowId=9;const registry=new ToolRegistry().register(taskProgressTool());
 registry.register({name:'desktop_background_describe',description:'observe',parameters:{type:'object',properties:{app:{type:'string'},windowId:{type:'integer'},windowTitle:{type:'string'}}},actionClass:'read',async run(a,ctx){
  if((a as {windowId?:number}).windowId!==undefined&&(a as {windowId?:number}).windowId!==windowId)throw Error('old window closed');
  if(!options.untyped)ctx.recordDesktopEvidence?.({...identity,windowId,kind:'observation',valueHash:hash(value)});
  return JSON.stringify({windowTitle:'demo.txt',targets:[{targetId:'observed',value}]});
 }});
 registry.register<{targetId:string;text:string}>({name:'desktop_background_append_text',description:'append',parameters:{type:'object',properties:{targetId:{type:'string'},text:{type:'string'}}},actionClass:'outbound',alwaysAsk:true,async run(a,ctx){
  const before=value;value+=a.text;
  if(options.uncertain)throw Object.assign(new Error('Native AX delivery uncertain'),{deliveryUnknown:true});
  if(!options.untyped)ctx.recordDesktopEvidence?.({...identity,windowId,...(options.wrongTarget?{windowTitle:'other.txt'}:{}),kind:'verified-append',valueHash:hash(value),beforeHash:hash(before),appendedText:a.text,operationId:'native-op'});
  return '{"status":"verified"}';
 }});
 return {registry,value:()=>value,edit:(text:string)=>{value=text;},move:()=>{windowId=10;}};
}
function provider(turns:({name:string;args:object}|string)[],prefix=''){
 let index=0;const requests:ChatRequest[]=[];const model:ChatModel={id:'desktop-progress-test',chat:async request=>{
  requests.push(request);if(!request.tools.length)return {text:'NONE',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};
  const turn=turns[index++];if(!turn)throw Error('Unnecessary executor turn');
  return {text:typeof turn==='string'?turn:'',toolCalls:typeof turn==='string'?[]:[{id:prefix+'c'+index,name:turn.name,argumentsText:JSON.stringify(turn.args)}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};
 }};return {model,requests};
}
const observe={name:'desktop_background_describe',args:{app:'TextEdit',windowId:9}};
const append={name:'desktop_background_append_text',args:{targetId:'observed',text:'İstanbul 👩‍💻.'}};
const plan={planEveryTask:true,requestPlanApproval:async(steps:string[])=>({kind:'go' as const,steps})};
it('completes a bound desktop plan from real typed verification without model tracking calls',async()=>{
 const f=fixture(),p=provider([observe,append,'Done.']),events:AgentEvent[]=[];
 const result=await runAgent({goal,tools:f.registry,model:p.model,...plan,maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(f.value()).toBe('old\nİstanbul 👩‍💻.');
 expect(tasksFromEvents(events)[0]!.status).toBe('completed');expect(tasksFromEvents(events)[0]!.steps).toHaveLength(3);
 expect(events.filter(e=>e.type==='approval.resolved')).toHaveLength(1);
 expect(p.requests.filter(r=>r.tools.length)).toHaveLength(2);
 expect(p.requests.filter(r=>r.tools.length).every(r=>!r.tools.some(t=>t.name==='task_update'))).toBe(true);
});
it('never turns Reject into desktop completion or a second action',async()=>{
 const f=fixture(),events:AgentEvent[]=[];
 await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'reject'})});
 expect(f.value()).toBe('old\n');const task=tasksFromEvents(events)[0]!;expect(task.status).toBe('stopped');
 expect(task.steps.slice(1).every(s=>s.status!=='completed')).toBe(true);
});
it('reobserves on resume without appending twice or requesting another action approval',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,signal:stop.signal,maxSteps:3,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='verified-append')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 expect(initial.status).toBe('stopped');const resumed=provider([],'resume-');
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:resumed.model,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:1,emit:e=>events.push(e),requestApproval:async()=>{throw Error('No second action approval');}});
 expect(result.status).toBe('done');expect(f.value()).toBe('old\nİstanbul 👩‍💻.');expect(tasksFromEvents(events)[0]!.status).toBe('completed');
 expect(resumed.requests.filter(r=>r.tools.length)).toHaveLength(0);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_append_text')).toHaveLength(1);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_describe')).toHaveLength(2);
});
it('does not reuse completion after the field changes while interrupted',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,signal:stop.signal,maxSteps:3,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='verified-append')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 f.edit('user changed the field');
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:provider(['Cannot verify.']).model,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:1,emit:e=>events.push(e),requestApproval:async()=>({kind:'reject'})});
 expect(result.status).toBe('stopped');expect(f.value()).toBe('user changed the field');expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_append_text')).toHaveLength(1);
});
it.each([{untyped:true},{wrongTarget:true}])('does not certify untyped output or a different window: %j',async options=>{
 const f=fixture(options),events:AgentEvent[]=[];
 await runAgent({goal,tools:f.registry,model:provider([observe,append,'Done.','Still done.']).model,...plan,maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
});
it('rechecks authorization after the real approval instead of completing or writing',async()=>{
 const f=fixture(),events:AgentEvent[]=[];let permitted=true;
 await runAgent({goal,tools:f.registry,model:provider([observe,append,'Access revoked.']).model,...plan,maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>{permitted=false;return {kind:'approve'};},authorize:async r=>r.tool==='desktop_background_append_text'?(permitted?{kind:'ask',reason:'approval required'}:{kind:'deny',reason:'revoked'}):{kind:'allow'}});
 expect(f.value()).toBe('old\n');expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');
 const call=events.find(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_append_text');
 expect(events.some(e=>e.type==='tool.started'&&call?.type==='tool.proposed'&&e.callId===call.callId)).toBe(false);
});
it('preserves uncertainty on resume and sends neither a repeat nor a fabricated completion',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,signal:stop.signal,maxSteps:3,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='verified-append')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;task.operations.push({runId:task.activeRunId,callId:'uncertain',tool:'desktop_background_append_text',actionClass:'outbound',status:'unknown'});
 const fresh:AgentEvent[]=[];
 await runAgent({goal:'Devam et',tools:f.registry,model:provider([]).model,resumeTask:task,history:initial.messages,maxSteps:1,emit:e=>fresh.push(e),requestApproval:async()=>({kind:'reject'})});
 expect(fresh.some(e=>e.type==='tool.started')).toBe(false);
 expect(tasksFromEvents([...events,...fresh])[0]!.status).not.toBe('completed');
 expect(f.value()).toBe('old\nİstanbul 👩‍💻.');
});
it('requires current read authorization before reusing desktop completion on resume',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,signal:stop.signal,maxSteps:3,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='verified-append')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 const fresh:AgentEvent[]=[];
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:provider([]).model,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:1,emit:e=>fresh.push(e),requestApproval:async()=>({kind:'reject'}),authorize:async()=>({kind:'deny',reason:'desktop connection disabled'})});
 expect(result.status).not.toBe('done');expect(fresh.some(e=>e.type==='tool.started')).toBe(false);
 expect(tasksFromEvents([...events,...fresh])[0]!.status).not.toBe('completed');
});
it('leaves user-edited plans on explicit tracking instead of guessing step meanings',async()=>{
 const f=fixture(),p=provider([observe,append,'Done.']),events:AgentEvent[]=[];
 await runAgent({goal,tools:f.registry,model:p.model,planEveryTask:true,requestPlanApproval:async()=>({kind:'go',steps:['Inspect manually, then decide.']}),maxSteps:3,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(events.filter(e=>e.type==='task.progress')).toHaveLength(0);
 expect(p.requests.filter(r=>r.tools.length).every(r=>r.tools.some(t=>t.name==='task_update'))).toBe(true);
});
it('refreshes an observed target after Stop before the first append, using current field content',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe]).model,...plan,signal:stop.signal,maxSteps:2,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='observation')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 expect(initial.status).toBe('stopped');f.edit('new user text\n');
 const resumed=provider([append],'new-');
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:resumed.model,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:2,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(f.value()).toBe('new user text\nİstanbul 👩‍💻.');
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_describe')).toHaveLength(2);
 expect(events.filter(e=>e.type==='tool.proposed'&&e.tool==='desktop_background_append_text')).toHaveLength(1);
});
it('persists uncertain native delivery and stops instead of repeating a possibly delivered append',async()=>{
 const f=fixture({uncertain:true}),events:AgentEvent[]=[];
 const result=await runAgent({goal,tools:f.registry,model:provider([observe,append,observe,append]).model,...plan,maxSteps:4,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('stopped');const task=tasksFromEvents(events)[0]!;
 expect(task.operations.find(o=>o.tool==='desktop_background_append_text')?.status).toBe('unknown');
 expect(f.value()).toBe('old\nİstanbul 👩‍💻.');expect(events.filter(e=>e.type==='approval.resolved')).toHaveLength(1);
 expect(task.steps.slice(1).every(s=>s.status!=='completed')).toBe(true);
});

it('rebinds a unique named window before the first write after interruption',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe]).model,...plan,signal:stop.signal,maxSteps:2,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='observation')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 f.move();f.edit('new window content\n');
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:provider([append]).model,resumeTask:tasksFromEvents(events)[0],history:initial.messages,maxSteps:2,emit:e=>events.push(e),requestApproval:async()=>({kind:'approve'})});
 expect(result.status).toBe('done');expect(f.value()).toBe('new window content\nİstanbul 👩‍💻.');
 expect(events.filter(e=>e.type==='approval.resolved')).toHaveLength(1);
});
it('supersedes an interrupted read with real current-field verification without cancelling unknown writes',async()=>{
 const f=fixture(),events:AgentEvent[]=[],stop=new AbortController();
 const initial=await runAgent({goal,tools:f.registry,model:provider([observe,append]).model,...plan,signal:stop.signal,maxSteps:3,emit:e=>{events.push(e);if(e.type==='tool.finished'&&e.desktopEvidence?.kind==='verified-append')stop.abort();},requestApproval:async()=>({kind:'approve'})});
 const task=tasksFromEvents(events)[0]!;task.operations.push({runId:task.activeRunId,callId:'lost-read',tool:'desktop_background_describe',actionClass:'read',status:'unknown'});
 const result=await runAgent({goal:'Devam et',tools:f.registry,model:provider([]).model,resumeTask:task,history:initial.messages,maxSteps:1,emit:()=>{},requestApproval:async()=>({kind:'reject'})});
 expect(result.status).toBe('done');expect(f.value()).toBe('old\nİstanbul 👩‍💻.');
});
