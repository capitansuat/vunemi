import {beforeEach,expect,it,vi} from 'vitest';
import type {AgentEvent,RunOptions} from '@vunemi/agent-core';
const state=vi.hoisted(()=>({serial:0,decisions:[] as unknown[]}));
vi.mock('@vunemi/agent-core',async original=>({...await original<typeof import('@vunemi/agent-core')>(),
 createModel:(id:string)=>({id,contextWindow:async()=>20_000}),
 runAgent:async(options:RunOptions)=>{
  const runId='run-'+(++state.serial);options.emit({type:'run.started',runId,goal:options.goal,model:'test',at:1});
  let wait:Promise<unknown>;
  if(options.goal==='plan'){
   options.emit({type:'plan.proposed',runId,steps:['Synthetic step'],at:2});wait=options.requestPlanApproval!(['Synthetic step']);
  }else if(options.goal==='handoff'){
   options.emit({type:'handoff.required',runId,callId:'shared-id',reason:'Synthetic handoff',at:2});wait=options.requestHandoff!({callId:'shared-id',reason:'Synthetic handoff'});
  }else{
   options.emit({type:'approval.required',runId,stepId:'step',callId:'shared-id',tool:'synthetic_write',args:{},actionClass:'write-local',reason:'Synthetic approval'});wait=options.requestApproval({callId:'shared-id',tool:'synthetic_write',args:{},actionClass:'write-local',reason:'Synthetic approval'});
  }
  const decision=await Promise.race([wait,new Promise<null>(resolve=>options.signal!.addEventListener('abort',()=>resolve(null),{once:true}))]);
  if(decision!==null)state.decisions.push(decision);
  if(options.goal==='repeat-approval'&&decision!==null){
   options.emit({type:'approval.required',runId,stepId:'step-2',callId:'shared-id',tool:'synthetic_write',args:{value:2},actionClass:'write-local',reason:'Second synthetic approval'});
   const second=await Promise.race([options.requestApproval({callId:'shared-id',tool:'synthetic_write',args:{value:2},actionClass:'write-local',reason:'Second synthetic approval'}),new Promise<null>(resolve=>options.signal!.addEventListener('abort',()=>resolve(null),{once:true}))]);
   if(second!==null)state.decisions.push(second);
  }
  options.emit({type:'run.finished',runId,status:decision===null?'stopped':'done',detail:'synthetic',at:3});
  return {runId,status:decision===null?'stopped':'done',detail:'synthetic',messages:[]} as any;
 },
}));
const {AgentSession}=await import('../../src/main/session.js');
beforeEach(()=>{state.serial=0;state.decisions=[];});
function fixture(){const events:AgentEvent[]=[];const session=new AgentSession({tools:{list:()=>[],get:()=>undefined} as any,emit:event=>events.push(event),authorize:async()=>({kind:'allow'}),onUntrustedOutput:()=>{},grants:new Set()});return {session,events};}
async function pending(f:ReturnType<typeof fixture>,kind:string){
 const job=f.session.start(kind,'test');await vi.waitFor(()=>expect(f.events.at(-1)?.type).toBe(kind==='plan'?'plan.proposed':kind==='handoff'?'handoff.required':'approval.required'));
 const event=f.events.at(-1)! as any;return {job,owner:{runId:event.runId,requestId:event.requestId}};
}
function resolve(session:any,kind:string,owner:any){return kind==='plan'?session.resolvePlan({kind:'go',steps:['Synthetic step']},owner):kind==='handoff'?session.resolveHandoff('shared-id','done',owner):session.resolveApproval('shared-id',{kind:'approve'},owner);}
it.each(['approval','handoff','plan'])('rejects stale %s owner even when a new run reuses the same call ID',async kind=>{
 const f=fixture(),first=await pending(f,kind);expect(first.owner.requestId).toMatch(/^[\w-]+$/);
 f.session.stop();await first.job;const second=await pending(f,kind);expect(second.owner.requestId).not.toBe(first.owner.requestId);
 expect(resolve(f.session,kind,first.owner)).toBe(false);expect(state.decisions).toEqual([]);
 expect(resolve(f.session,kind,second.owner)).toBe(true);expect(resolve(f.session,kind,second.owner)).toBe(false);await second.job;expect(state.decisions).toHaveLength(1);
});
it.each(['approval','handoff','plan'])('rejects missing, paused and stopped %s ownership without consuming the live wait',async kind=>{
 const f=fixture(),live=await pending(f,kind);expect(resolve(f.session,kind,undefined)).toBe(false);
 f.session.pause();expect(resolve(f.session,kind,live.owner)).toBe(false);f.session.resume();
 f.session.stop();expect(resolve(f.session,kind,live.owner)).toBe(false);await live.job;expect(state.decisions).toEqual([]);
});
it.each([{},null,{kind:'cancelled'},{kind:'expired'},{kind:'approve',extra:true}])('rejects malformed generic approval %# and leaves the valid card pending',async invalid=>{
 const f=fixture(),live=await pending(f,'approval');expect((f.session.resolveApproval as any)('shared-id',invalid,live.owner)).toBe(false);expect(state.decisions).toEqual([]);expect(resolve(f.session,'approval',live.owner)).toBe(true);await live.job;
});
it('rejects the previous request token when the same active run emits another card with the same call ID',async()=>{
 const f=fixture(),first=await pending(f,'repeat-approval');expect(resolve(f.session,'approval',first.owner)).toBe(true);
 await vi.waitFor(()=>expect((f.events.at(-1) as any).requestId).not.toBe(first.owner.requestId));
 const second=f.events.at(-1)! as any,owner={runId:second.runId,requestId:second.requestId};
 expect(resolve(f.session,'approval',first.owner)).toBe(false);expect(resolve(f.session,'approval',owner)).toBe(true);await first.job;expect(state.decisions).toHaveLength(2);
});
it('checks adjustment ownership without consuming a live approval and rejects old or ended ownership',async()=>{
 const f=fixture(),first=await pending(f,'approval');expect(f.session.canResolveApproval('shared-id',first.owner)).toBe(true);expect(f.session.canResolveApproval('shared-id',first.owner)).toBe(true);expect(state.decisions).toEqual([]);
 f.session.pause();expect(f.session.canResolveApproval('shared-id',first.owner)).toBe(false);f.session.resume();
 f.session.stop();await first.job;const second=await pending(f,'approval');
 expect(f.session.canResolveApproval('shared-id',first.owner)).toBe(false);expect(f.session.canResolveApproval('shared-id',second.owner)).toBe(true);
 expect(resolve(f.session,'approval',second.owner)).toBe(true);expect(f.session.canResolveApproval('shared-id',second.owner)).toBe(false);await second.job;
});
