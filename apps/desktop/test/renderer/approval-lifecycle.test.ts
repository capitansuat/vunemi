import {expect,it} from 'vitest';
import {foldEvent,activeTurnAction,currentActionOwner,type RunView} from '../../src/renderer/src/lib/fold.js';
import type {AgentEvent} from '@vunemi/agent-core';
function fold(extra:any[]){return [...[{type:'run.started',runId:'r',goal:'g',model:'m',at:1},{type:'step.started',runId:'r',stepId:'s',index:0,at:2},{type:'tool.proposed',runId:'r',stepId:'s',callId:'c',tool:'test',args:{},actionClass:'read'}],...extra].reduce((runs,e)=>foldEvent(runs,e as AgentEvent),[] as RunView[])[0]!;}
it('preserves request identities independently from call IDs and plan text',()=>{
 const run=fold([{type:'approval.required',runId:'r',callId:'c',requestId:'approval-1',reason:'approve'},{type:'handoff.required',runId:'r',callId:'c',requestId:'handoff-1',reason:'help'},{type:'plan.proposed',runId:'r',requestId:'plan-1',steps:['Read'],at:3}]);
 expect(run.steps[0]!.calls[0]!.requestId).toBe('handoff-1');expect(run.plan?.requestId).toBe('plan-1');
});
it.each(['approval.required','approval.resolved','handoff.required','handoff.resolved','choice.answered','plan.proposed','plan.resolved'])('ignores late %s after terminal run',type=>{
 const run=fold([{type:'approval.required',runId:'r',callId:'c',requestId:'old',reason:'approve'},{type:'choice.asked',runId:'r',stepId:'s',callId:'choice',card:{kind:'choice',question:'Q',options:['A','B']},at:3},{type:'run.finished',runId:'r',status:'stopped',detail:'Stopped',at:4}]);
 const event={type,runId:'r',callId:type.startsWith('choice')?'choice':'c',requestId:'late',reason:'late',steps:['Late'],decision:{kind:'approve'},text:'A',at:5};
 expect(foldEvent([run],event as any)[0]).toEqual(run);expect(activeTurnAction(run,true)).toBeNull();
});
it('binds latest action to run/request identity and refuses captured, paused or stopped owners',()=>{
 const run=fold([{type:'handoff.required',runId:'r',callId:'c',requestId:'fresh',reason:'help'}]),call=run.steps[0]!.calls[0]!;
 const state={running:true,paused:false,taskApprovalStopped:false,sessions:{current:'session'},activeRun:{sessionId:'session',runId:'r'},runs:[run]};
 expect(currentActionOwner(state,'handoff',call)).toEqual({runId:'r',requestId:'fresh'});
 expect(currentActionOwner({...state,paused:true},'handoff',call)).toBeUndefined();
 expect(currentActionOwner({...state,taskApprovalStopped:true},'handoff',call)).toBeUndefined();
 expect(currentActionOwner({...state,activeRun:{sessionId:'session',runId:'new'}},'handoff',call)).toBeUndefined();
 expect(currentActionOwner(state,'handoff',{...call})).toBeUndefined();
 delete call.requestId;expect(currentActionOwner(state,'handoff',call)).toBeUndefined();
});
it('selects the fresh choice request when a same-run call ID is reused',()=>{
 const card={kind:'choice',question:'Q',options:['A','B']};
 const run=fold([{type:'choice.asked',runId:'r',stepId:'s',callId:'same',requestId:'old',card,at:3},{type:'choice.asked',runId:'r',stepId:'s',callId:'same',requestId:'new',card,at:4}]);
 const action=activeTurnAction(run,true);expect(action?.kind).toBe('choice');if(action?.kind==='choice')expect(action.choice.requestId).toBe('new');
});
it.each(['approval','handoff'] as const)('replayed duplicate call ID preserves old settlement and renders only new %s arguments',kind=>{
 const run=fold([{type:'approval.required',runId:'r',callId:'c',requestId:'first',reason:'first'},{type:'tool.started',runId:'r',callId:'c',at:3},{type:'tool.finished',runId:'r',callId:'c',ok:true,output:'Original result',durationMs:1},{type:'step.started',runId:'r',stepId:'second',index:1,at:4},{type:'tool.proposed',runId:'r',stepId:'second',callId:'c',tool:'test',args:{path:'/new-target.txt'},actionClass:'read'},{type:`${kind}.required`,runId:'r',callId:'c',requestId:'second-request',reason:'new',at:5}]);
 expect(run.steps[0]!.calls[0]).toMatchObject({requestId:'first',status:'ok',output:'Original result',args:{}});
 const action=activeTurnAction(run,true);expect(action?.kind).toBe(kind);if(action?.kind==='approval'||action?.kind==='handoff')expect(action.call).toMatchObject({requestId:'second-request',args:{path:'/new-target.txt'}});
 const settled=foldEvent([run],{type:'tool.finished',runId:'r',callId:'c',ok:false,output:'Second failed',durationMs:2})[0]!;
 expect(settled.steps[0]!.calls[0]).toEqual(run.steps[0]!.calls[0]);expect(settled.steps[1]!.calls[0]).toMatchObject({output:'Second failed',status:'error'});
});
