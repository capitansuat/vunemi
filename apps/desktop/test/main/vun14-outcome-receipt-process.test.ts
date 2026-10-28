import {beforeAll,afterEach,afterAll,expect,it,vi} from 'vitest';
import {fork,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ToolRegistry,taskProgressTool,tasksFromEvents,type ChatModel,type AgentEvent} from '@vunemi/agent-core';
import {createCalendarTools} from '@vunemi/mac';
import {SessionCoordinatorHost,type SessionCoordinatorChild} from '../../src/main/session-coordinator-host.js';

// VUN-14: main-owned calendar adapter receipt must cross the real session worker boundary before the tool result.
const hosts:SessionCoordinatorHost[]=[],children:ChildProcess[]=[];let dir='',binary='';
beforeAll(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'vun14-receipt-process-')));binary=join(dir,'worker.cjs');execFileSync(resolve('../../packages/mac/node_modules/.bin/esbuild'),[resolve('test/main/fixtures/session-process.ts'),'--bundle','--platform=node','--format=cjs',`--outfile=${binary}`],{stdio:'pipe'});});
afterEach(()=>{for(const h of hosts.splice(0))h.dispose();for(const c of children.splice(0))if(c.exitCode===null)c.kill('SIGKILL');});afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const usage={promptTokens:20,completionTokens:5,ttftMs:1,tokensPerSec:10};
const goal='Create calendar event "VUN14 Synthetic" from 2028-02-29T10:00Z to 2028-02-29T11:00Z';
const args={title:'VUN14 Synthetic',start:'2028-02-29T10:00Z',end:'2028-02-29T11:00Z'};

function setup(readbackError:boolean){
 const store=new Map<string,Record<string,unknown>>();
 const call=vi.fn(async(op:string,a:any)=>{
  if(op==='events')return {events:[]};
  if(op==='event_create'){const e={id:'event-1',calendarId:'calendar-1',calendar:'Synthetic',title:a.title,start:a.start,end:a.end,allDay:a.allDay===true};store.set(e.id,{...e,start:new Date(a.start).toISOString(),end:new Date(a.end).toISOString()});return e;}
  if(op==='event_get'){if(readbackError)throw Error('Synthetic readback unavailable');return store.get(a.id);}
  if(op==='event_remove')return {};
  throw Error('unexpected '+op);
 });
 const tools=new ToolRegistry();for(const tool of createCalendarTools({helper:{permissions:async()=>({calendars:true}),call} as any}))tools.register(tool,'calendar');tools.register(taskProgressTool(),'tasks');
 let turns=0;const chat:ChatModel['chat']=async req=>{turns++;if(req.messages.some(m=>m.role==='tool'))return {text:'Done',toolCalls:[],usage};return {text:'',toolCalls:[{id:'create-'+turns,name:'calendar_create',argumentsText:JSON.stringify(args)}],usage};};
 const events:AgentEvent[]=[],options={tools,grants:new Set<string>(),emit:(e:AgentEvent)=>events.push(e),authorize:(req:any)=>req.tool==='calendar_create'?{kind:'ask',reason:'Synthetic approval'} as never:{kind:'allow' as const},onUntrustedOutput:()=>{},areas:()=>[{id:'calendar',summary:'Calendar events on this Mac'}],modelFactory:(spec:string)=>({id:spec,contextWindow:async()=>32768,vision:async()=>false,chat}),onRunSettled:vi.fn(async()=>{})};
 const spawn=()=>{const child=fork(binary,[],{stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced'});child.stderr?.on('data',b=>process.stderr.write(b));children.push(child);return{postMessage:(m:unknown)=>{child.send(m as never);},on:(e:string,f:(v:any)=>void)=>child.on(e as any,f),kill:()=>child.kill('SIGKILL')} as SessionCoordinatorChild;};
 const host=new SessionCoordinatorHost({spawn,sessionId:()=> 'vun14-session',options,locale:()=> 'en'});hosts.push(host);
 return {host,events,call};
}
async function drive(f:ReturnType<typeof setup>){
 const started=f.host.start(goal,'synthetic:model');
 await vi.waitFor(()=>expect(f.events.some(e=>e.type==='plan.proposed')).toBe(true),{timeout:10000});
 const plan=f.events.find(e=>e.type==='plan.proposed') as Extract<AgentEvent,{type:'plan.proposed'}>;
 expect(await f.host.resolvePlan({kind:'go',steps:plan.steps},{runId:plan.runId,requestId:plan.requestId!})).toBe(true);
 await vi.waitFor(()=>expect(f.events.some(e=>e.type==='approval.required')).toBe(true),{timeout:10000});
 const offer=f.events.find(e=>e.type==='approval.required') as Extract<AgentEvent,{type:'approval.required'}>;
 expect(await f.host.resolveApproval(offer.callId,{kind:'approve'},{runId:offer.runId,requestId:offer.requestId!})).toBe(true);
 const status=await started;
 const finished=f.events.find(e=>e.type==='tool.finished'&&e.callId===offer.callId) as Extract<AgentEvent,{type:'tool.finished'}>;
 return {status,finished,task:tasksFromEvents(f.events).at(-1)!,offer};
}

it('verified calendar readback receipt reaches the worker and completes the workflow without task_update',async()=>{
 const f=setup(false);const {status,finished,task,offer}=await drive(f);expect(status).toBe('done');
 expect(finished).toMatchObject({ok:true,outcomeEvidence:{version:1,domain:'calendar',kind:'event-created',targetId:'event-1',source:'controller-readback'}});
 expect(f.call.mock.calls.filter(c=>c[0]==='event_create')).toHaveLength(1);
 expect(f.events.filter(e=>e.type==='task.progress')).toHaveLength(2);expect(f.events.some(e=>e.type==='tool.proposed'&&e.tool==='task_update')).toBe(false);
 expect(task.status).toBe('completed');expect(task.steps.map(s=>[s.status,s.evidence,s.receipts[0]?.callId])).toEqual([['completed','tool_result',offer.callId],['completed','tool_result',offer.callId]]);
},20000);

it('saved-unverified calendar write crosses the worker with no receipt and leaves the task for review',async()=>{
 const f=setup(true);const {status,finished,task}=await drive(f);
 // The unverified write leaves the application-owned workflow unfinished, so the run ends needing attention.
 expect(status).toBe('failed');expect(f.events.find(e=>e.type==='run.finished')).toMatchObject({status:'failed'});
 expect(finished).toMatchObject({ok:true});expect(finished).not.toHaveProperty('outcomeEvidence');expect(finished.output).toContain('not independently verified');
 expect(f.call.mock.calls.filter(c=>c[0]==='event_create')).toHaveLength(1);expect(f.events.filter(e=>e.type==='task.progress')).toHaveLength(0);
 expect(task.status).not.toBe('completed');expect(task.steps.every(s=>s.status!=='completed')).toBe(true);
},20000);
