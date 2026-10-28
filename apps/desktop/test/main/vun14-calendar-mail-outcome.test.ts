import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {runAgent,ToolRegistry,taskProgressTool,tasksFromEvents,taskResumeContext,type AgentEvent,type ChatModel,type ToolDef} from '@vunemi/agent-core';
import {createCalendarTools} from '@vunemi/mac';
import {MailAccounts,Outbox,createMailTools,ImapSmtpAccount} from '@vunemi/mail';
import {AppleMailAccount,MAIL_COMPOSE} from '../../src/main/apple-mail.js';

// VUN-14 source/fixture acceptance: real calendar and mail adapters, synthetic EventKit/IMAP/Apple Mail backends only.
beforeEach(()=>setLocale('en'));afterEach(()=>setLocale('tr'));

type Turn={calls?:{name:string;args:Record<string,unknown>}[];text?:string};
function scripted(turns:Turn[]):ChatModel{let i=0;return{id:'synthetic',chat:async()=>{const turn=turns[i++]??{text:'Done'};return{text:turn.text??'',toolCalls:(turn.calls??[]).map((c,n)=>({id:`call-${i}-${n}`,name:c.name,argumentsText:JSON.stringify(c.args)})),usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};}
async function run(goal:string,tools:ToolDef[],turns:Turn[],extra:Partial<Parameters<typeof runAgent>[0]>={}){
 const events:AgentEvent[]=[],registry=new ToolRegistry();for(const tool of tools)registry.register(tool);registry.register(taskProgressTool());
 const result=await runAgent({goal,tools:registry,model:scripted(turns),emit:e=>events.push(e),requestPlanApproval:async steps=>({kind:'go',steps}),requestApproval:async()=>({kind:'approve'}),runId:'run-1',now:()=>1,...extra});
 return {result,events,task:tasksFromEvents(events).at(-1)!};
}
const finished=(events:AgentEvent[],tool?:string)=>events.filter((e):e is Extract<AgentEvent,{type:'tool.finished'}>=>e.type==='tool.finished').filter(e=>!tool||events.some(p=>p.type==='tool.proposed'&&p.callId===e.callId&&p.tool===tool));
const progress=(events:AgentEvent[])=>events.filter(e=>e.type==='task.progress');

/** Synthetic EventKit store behind the helper opcodes; readback uses a different but equivalent instant encoding. */
function eventKit(opts:{readbackError?:boolean;dropUpdate?:boolean;readbackTitle?:string}={}){
 const store=new Map<string,Record<string,unknown>>();let next=1;
 store.set('event-existing',{id:'event-existing',calendarId:'calendar-1',calendar:'Synthetic',title:'Synthetic existing',start:'2028-03-01T09:00:00.000Z',end:'2028-03-01T10:00:00.000Z',allDay:false});
 const call=vi.fn(async(op:string,args:any)=>{
  if(op==='events')return {events:[]};
  if(op==='event_create'){const id=`event-${next++}`;const e={id,calendarId:'calendar-1',calendar:'Synthetic',title:args.title,start:args.start,end:args.end,allDay:args.allDay===true};store.set(id,{...e,start:new Date(args.start).toISOString(),end:new Date(args.end).toISOString()});return e;}
  if(op==='event_get'){if(opts.readbackError&&store.size>1)throw Error('Synthetic readback unavailable');const e=store.get(args.id);if(!e)throw Error('No such event');return {...e,...(opts.readbackTitle&&args.id!=='event-existing'?{title:opts.readbackTitle}:{})};}
  if(op==='event_update'){const before={...store.get(args.id)!};const {id,...fields}=args;const after={...before,...fields};if(!opts.dropUpdate)store.set(id,after);return {before,after};}
  if(op==='event_remove')return {};
  throw Error('unexpected '+op);
 });
 const tools=createCalendarTools({helper:{permissions:async()=>({calendars:true}),call} as any});
 return {tools,call,store,writes:()=>call.mock.calls.filter(c=>['event_create','event_update'].includes(c[0])).length};
}

/** Real ImapSmtpAccount; only the network client is a synthetic in-memory Drafts mailbox. */
function imap(opts:{mutateStored?:(source:string)=>string}={}){
 const config={email:'sender@example.com',user:'sender',imapHost:'imap.example.invalid',imapPort:993,smtpHost:'smtp.example.invalid',smtpPort:587,smtpSecure:false};
 const account=new ImapSmtpAccount(config,()=> 'synthetic-password');const messages=new Map<number,Buffer>();let uid=40;
 const client={isClosed:true,connect:vi.fn(async()=>{}),mailbox:{uidValidity:42n},list:vi.fn(async()=>[{path:'Drafts',specialUse:'\\Drafts'}]),getMailboxLock:vi.fn(async()=>({release:vi.fn()})),
  append:vi.fn(async(_box:string,bytes:Buffer)=>{uid++;messages.set(uid,opts.mutateStored?Buffer.from(opts.mutateStored(bytes.toString('utf8'))):bytes);return {uid,uidValidity:42n};}),
  fetchOne:vi.fn(async(id:string)=>{const source=messages.get(Number(id));return source?{uid:Number(id),size:source.length,flags:new Set(['\\Draft']),source}:false;}),messageDelete:vi.fn()};
 vi.spyOn(account as unknown as {client:()=>unknown},'client').mockReturnValue(client);
 const accounts=new MailAccounts();accounts.add({id:'imap-1',label:'Synthetic IMAP',account});
 return {tools:createMailTools({accounts,outbox:new Outbox()}),client};
}
/** Real AppleMailAccount; only the AppleScript runner is synthetic. */
function appleMail(){
 const runner=vi.fn(async(template:string,input:Record<string,unknown>)=>template===MAIL_COMPOSE?{saved:true,id:7}:input.app?{ready:true}:{});
 const account=new AppleMailAccount(runner as never,{account:'Synthetic Mail',email:'sender@example.com'});
 const accounts=new MailAccounts();accounts.add({id:'apple-1',label:'Synthetic Apple Mail',account});
 return {tools:createMailTools({accounts,outbox:new Outbox()}),saves:()=>runner.mock.calls.filter(c=>c[0]===MAIL_COMPOSE).length};
}

const calendarGoal='Create calendar event "VUN14 Synthetic" from 2028-02-29T10:00Z to 2028-02-29T11:00Z';
const calendarArgs={title:'VUN14 Synthetic',start:'2028-02-29T10:00Z',end:'2028-02-29T11:00Z'};
const draftGoal='Save a draft to recipient@example.com with subject "VUN14 Synthetic" and body "Synthetic body line"';
const draftArgs={to:['recipient@example.com'],subject:'VUN14 Synthetic',body:'Synthetic body line'};

it('calendar add advances both workflow steps only from the independent exact-ID readback receipt',async()=>{
 const k=eventKit();const {result,events,task}=await run(calendarGoal,k.tools,[{calls:[{name:'calendar_create',args:calendarArgs}]}]);
 expect(result.status).toBe('done');expect(k.call.mock.calls.map(c=>c[0])).toEqual(['events','event_create','event_get']);
 const done=finished(events,'calendar_create')[0]!;expect(done.outcomeEvidence).toMatchObject({version:1,domain:'calendar',kind:'event-created',targetId:'event-1',source:'controller-readback'});
 expect(JSON.stringify(done.outcomeEvidence)).not.toContain('VUN14 Synthetic');
 expect(progress(events)).toHaveLength(2);expect(task.status).toBe('completed');
 expect(task.steps.map(s=>({status:s.status,evidence:s.evidence,callId:s.receipts[0]?.callId}))).toEqual([{status:'completed',evidence:'tool_result',callId:done.callId},{status:'completed',evidence:'tool_result',callId:done.callId}]);
});

it('calendar add receipt for a different title is valid proof but never completes the requested workflow',async()=>{
 const k=eventKit();
 const {events,task}=await run(calendarGoal,k.tools,[{calls:[{name:'calendar_create',args:{...calendarArgs,title:'Different synthetic'}}]},{calls:[{name:'task_update',args:{step:1,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 expect(finished(events,'calendar_create')[0]!.outcomeEvidence).toMatchObject({kind:'event-created'});
 expect(progress(events)).toHaveLength(0);expect(finished(events,'task_update')[0]).toMatchObject({ok:false});
 expect(task.status).not.toBe('completed');expect(task.steps.every(s=>s.status!=='completed')).toBe(true);
});

it('calendar add with failed readback stays saved-unverified, produces no proof and is never written again',async()=>{
 const k=eventKit({readbackError:true});
 const {events,task}=await run(calendarGoal,k.tools,[{calls:[{name:'calendar_create',args:calendarArgs}]},{calls:[{name:'calendar_create',args:{...calendarArgs,start:'2028-02-29T10:00:00.000Z',end:'2028-02-29T11:00:00Z',allDay:false,location:''}}]},{calls:[{name:'task_update',args:{step:1,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 const [first,second]=finished(events,'calendar_create');
 expect(first).toMatchObject({ok:true});expect(first).not.toHaveProperty('outcomeEvidence');expect(first!.output).toContain('not independently verified');
 expect(second).toMatchObject({ok:false});expect(second!.output).toContain('already has an acknowledged or uncertain effect');
 expect(k.writes()).toBe(1);expect(progress(events)).toHaveLength(0);expect(finished(events,'task_update')[0]).toMatchObject({ok:false});
 expect(task.status).toBe('needs_review');
 const snapshot=JSON.parse(taskResumeContext(task));expect(snapshot.successful.filter((s:{tool:string})=>s.tool==='calendar_create')).toEqual([]);expect(snapshot.acknowledgedUnverified).toEqual([expect.objectContaining({tool:'calendar_create',doNotRepeat:true,reviewNeeded:true})]);
 // A continuation of the same task still refuses the exact write instead of retrying for proof.
 const resumed:AgentEvent[]=[],registry=new ToolRegistry();for(const tool of k.tools)registry.register(tool);registry.register(taskProgressTool());
 await runAgent({goal:task.goal,resumeTask:task,tools:registry,model:scripted([{calls:[{name:'calendar_create',args:calendarArgs}]},{text:'Review needed'}]),emit:e=>resumed.push(e),requestApproval:async()=>({kind:'approve'}),runId:'run-2',now:()=>2});
 expect(k.writes()).toBe(1);expect(finished(resumed,'calendar_create')[0]).toMatchObject({ok:false});
});

it('calendar change completes an explicit step only with the event-updated readback receipt of that event',async()=>{
 const k=eventKit();
 const {events,task}=await run('Rename my synthetic existing event',k.tools,[{calls:[{name:'calendar_update',args:{id:'event-existing',title:'Synthetic renamed'}}]},{calls:[{name:'task_update',args:{step:1,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 const done=finished(events,'calendar_update')[0]!;expect(done.outcomeEvidence).toMatchObject({domain:'calendar',kind:'event-updated',targetId:'event-existing'});
 expect(finished(events,'task_update')[0]).toMatchObject({ok:true});expect(task.status).toBe('completed');expect(task.steps[0]).toMatchObject({status:'completed',evidence:'tool_result'});
 // Approval preview read, pre-write identity read, the single write, then the independent readback.
 expect(k.call.mock.calls.map(c=>c[0])).toEqual(['event_get','event_get','event_update','event_get']);
});

it('calendar change acknowledged by the write response but not read back is not completed or repeated',async()=>{
 const k=eventKit({dropUpdate:true});
 const {events,task}=await run('Rename my synthetic existing event',k.tools,[{calls:[{name:'calendar_update',args:{id:'event-existing',title:'Synthetic renamed'}}]},{calls:[{name:'calendar_update',args:{id:'event-existing',title:'Synthetic renamed'}}]},{calls:[{name:'task_update',args:{step:1,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 const [first,second]=finished(events,'calendar_update');
 expect(first).toMatchObject({ok:true});expect(first).not.toHaveProperty('outcomeEvidence');expect(second).toMatchObject({ok:false});
 expect(k.writes()).toBe(1);expect(finished(events,'task_update')[0]).toMatchObject({ok:false});expect(task.status).toBe('needs_review');
});

it('IMAP draft save advances the workflow only from the exact UID readback receipt',async()=>{
 const m=imap();const {result,events,task}=await run(draftGoal,m.tools,[{calls:[{name:'mail_draft',args:draftArgs}]}]);
 expect(result.status).toBe('done');expect(m.client.append).toHaveBeenCalledOnce();
 const done=finished(events,'mail_draft')[0]!;expect(done.outcomeEvidence).toMatchObject({domain:'mail-draft',kind:'draft-saved',source:'controller-readback'});
 const id=Buffer.from(JSON.stringify({mailbox:'Drafts',validity:'42',uid:41})).toString('base64url');expect(done.outcomeEvidence!.targetId).toBe('imap-1::'+id);
 expect(JSON.stringify(done.outcomeEvidence)).not.toContain('Synthetic body line');
 expect(progress(events)).toHaveLength(2);expect(task.status).toBe('completed');expect(task.steps.every(s=>s.evidence==='tool_result'&&s.receipts[0]?.callId===done.callId)).toBe(true);
});

it('IMAP draft to a different recipient is never adopted as the requested draft',async()=>{
 const m=imap();
 const {events,task}=await run(draftGoal,m.tools,[{calls:[{name:'mail_draft',args:{...draftArgs,to:['other@example.com']}}]},{calls:[{name:'task_update',args:{step:2,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 expect(finished(events,'mail_draft')[0]!.outcomeEvidence).toMatchObject({kind:'draft-saved'});
 expect(progress(events)).toHaveLength(0);expect(finished(events,'task_update')[0]).toMatchObject({ok:false});expect(task.status).not.toBe('completed');
});

it('IMAP draft whose stored content differs from the request stays saved-unverified and is not saved again',async()=>{
 const m=imap({mutateStored:source=>source.replace('Synthetic body line','Synthetic body changed')});
 const {events,task}=await run(draftGoal,m.tools,[{calls:[{name:'mail_draft',args:draftArgs}]},{calls:[{name:'mail_draft',args:{...draftArgs,to:[' Recipient@Example.com '],cc:[]}}]},{text:'Done'}]);
 const [first,second]=finished(events,'mail_draft');
 expect(first).toMatchObject({ok:true});expect(first).not.toHaveProperty('outcomeEvidence');expect(first!.output).toContain('not independently verified');
 expect(second).toMatchObject({ok:false});expect(m.client.append).toHaveBeenCalledOnce();expect(progress(events)).toHaveLength(0);expect(task.status).toBe('needs_review');
});

it('Apple Mail draft acknowledgement without a durable locator never produces proof or a second save',async()=>{
 const a=appleMail();
 const {events,task}=await run(draftGoal,a.tools,[{calls:[{name:'mail_draft',args:draftArgs}]},{calls:[{name:'mail_draft',args:draftArgs}]},{calls:[{name:'task_update',args:{step:1,status:'completed',evidenceCallIds:['call-1-0']}}]},{text:'Done'}]);
 const [first,second]=finished(events,'mail_draft');
 expect(first).toMatchObject({ok:true});expect(first).not.toHaveProperty('outcomeEvidence');expect(first!.output).toContain('not independently verified');
 expect(second).toMatchObject({ok:false});expect(a.saves()).toBe(1);expect(progress(events)).toHaveLength(0);expect(finished(events,'task_update')[0]).toMatchObject({ok:false});
 expect(task.status).toBe('needs_review');expect(JSON.parse(taskResumeContext(task)).acknowledgedUnverified).toEqual([expect.objectContaining({tool:'mail_draft',doNotRepeat:true})]);
});
