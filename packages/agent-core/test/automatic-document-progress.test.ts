import {it,expect} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import {taskProgressTool,tasksFromEvents} from '../src/tasks.js';
import type {AgentEvent} from '../src/events.js';
import type {ChatModel} from '../src/provider.js';
const goal='TextEdit arka planda /private/tmp/demo.txt belgesine "new" ekle ve kaydet; odağımı değiştirme.';
it.each([false,'observation','verified-append','uncertain','saved-but-unverifiable'] as const)('records native append before save and resumes without another append: stop=%s',async interrupted=>{
 const tools=new ToolRegistry().register(taskProgressTool()),events:AgentEvent[]=[];let value='old',disk='old',calls=0,approvals=0,refuseSave=false;const abort=new AbortController();
 const base={version:1 as const,bundleId:'com.apple.TextEdit',processStartedAt:100,windowId:9,windowTitle:'demo.txt',fieldRef:1,documentPath:'/private/tmp/demo.txt'};
 const a='a'.repeat(64),b='b'.repeat(64);
 tools.register({name:'desktop_background_document',description:'open append save',parameters:{type:'object',properties:{path:{type:'string'},text:{type:'string'}}},actionClass:'outbound',alwaysAsk:true,async run(_args,ctx){
  const prior=ctx.desktopDocumentState?.().receipts.some(e=>e.kind==='verified-append');
  ctx.recordDesktopEvidence?.({...base,kind:'observation',valueHash:prior?b:a});
  if(ctx.signal.aborted)throw Error('Stopped before append');
  if(!prior){ctx.recordDesktopAppendIntent?.();value+='new';calls++;if(interrupted==='uncertain')throw Object.assign(Error('Native response lost'),{deliveryUnknown:true});ctx.recordDesktopEvidence?.({...base,kind:'verified-append',valueHash:b,beforeHash:a,diskBeforeHash:a,appendedText:'new',operationId:'append-op'});}
  if(ctx.signal.aborted)throw Error('Stopped before save');
  if(refuseSave)throw Error('Document changed; cannot verify save');
  disk=value;ctx.recordDesktopEvidence?.({...base,kind:'verified-save',valueHash:b,diskHash:b,operationId:'save-op'});
  return 'Saved';
 }});
 const model:ChatModel={id:'unused-model',async chat(){throw Error('Bound document workflow must not require a model tracking turn');}};
 const options={tools,model,requestApproval:async()=>{approvals++;return {kind:'approve' as const};},planEveryTask:true,requestPlanApproval:async(steps:string[])=>({kind:'go' as const,steps}),maxSteps:2};
 const initial=await runAgent({...options,goal,signal:abort.signal,emit:e=>{events.push(e);if(interrupted&&e.type==='desktop.receipt'&&e.evidence.kind===(interrupted==='saved-but-unverifiable'?'verified-save':interrupted))abort.abort();}});
 if(interrupted==='saved-but-unverifiable'){
  refuseSave=true;const result=await runAgent({...options,goal:'Devam et',resumeTask:tasksFromEvents(events)[0],history:initial.messages,emit:e=>events.push(e)});
  expect(result.status).toBe('stopped');expect(calls).toBe(1);expect(tasksFromEvents(events)[0]!.status).not.toBe('completed');return;
 }
 if(interrupted==='uncertain'){
  const previous=tasksFromEvents(events)[0]!;const fresh:AgentEvent[]=[];await runAgent({...options,goal:'Devam et',resumeTask:previous,history:initial.messages,emit:e=>fresh.push(e)});
  expect(calls).toBe(1);expect(disk).toBe('old');expect(fresh.some(e=>e.type==='tool.started')).toBe(false);return;
 }
 if(interrupted){
  expect(initial.status).toBe('stopped');expect(disk).toBe('old');expect(tasksFromEvents(events)[0]!.steps[0]!.status).toBe('completed');
  await runAgent({...options,goal:'Devam et',resumeTask:tasksFromEvents(events)[0],history:initial.messages,emit:e=>events.push(e)});
 }
 expect(calls).toBe(1);expect(disk).toBe('oldnew');expect(tasksFromEvents(events)[0]!.status).toBe('completed');
 expect(approvals).toBe(interrupted?2:1);expect(events.some(e=>e.type==='tool.proposed'&&e.tool==='task_update')).toBe(false);
});
