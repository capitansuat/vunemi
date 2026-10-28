import {it,expect,vi} from 'vitest';import {AgentSession} from '../../src/main/session.js';
import {tasksFromEvents,type AgentEvent} from '@vunemi/agent-core';
it('holds shared running admission through native settlement and Stop',async()=>{let settle!:()=>void;const events:any[]=[];const session=new AgentSession({emit:(e:any)=>events.push(e),onRunSettled:()=>new Promise<void>(r=>settle=r)} as any);let release!:(s:any)=>void;const job=session.startNativeRecipe({runId:'native-r',goal:'test',execute:signal=>new Promise(r=>{release=r;signal.addEventListener('abort',()=>r('stopped'))})});expect(session.running).toBe(true);await expect(session.startNativeRecipe({runId:'second',goal:'x',execute:async()=> 'done'})).rejects.toThrow();session.stop();await Promise.resolve();expect(session.running).toBe(true);settle();await job;expect(session.running).toBe(false);expect(events.at(-1).status).toBe('stopped');});
it.each(['explicit','implicit','legacy'] as const)('refuses %s native recovery before loading a model or claiming Session',async mode=>{
 const events:AgentEvent[]=[];
 const native=tasksFromEvents([
  {type:'run.started',runId:'recipe',goal:'scheduled recipe',model:'recipe:textedit.append-save.v1',executionMode:'native-recipe',at:1},
  {type:'tool.proposed',runId:'recipe',stepId:'step',callId:'append',tool:'native_recipe_textedit_append_save',args:{},actionClass:'outbound'},
  {type:'tool.started',runId:'recipe',callId:'append',at:2},
  {type:'run.finished',runId:'recipe',status:'stopped',detail:'unknown after stop',at:3},
 ])[0]!;
 if(mode==='legacy')delete native.executionMode;
 const prepareModel=vi.fn(async()=>{throw Error('model must not load');});
 const session=new AgentSession({emit:(event:AgentEvent)=>events.push(event),latestTask:()=>native,prepareModel} as any);
 await expect(session.start('Resume','model',[],mode==='implicit'?{}:{resumeTask:native})).rejects.toThrow();
 expect(prepareModel).not.toHaveBeenCalled();expect(events).toEqual([]);expect(session.running).toBe(false);
});
it('Pause stops a native job and Resume never dispatches it again',async()=>{
 const events:AgentEvent[]=[];const execute=vi.fn((signal:AbortSignal)=>new Promise<'stopped'>(resolve=>signal.addEventListener('abort',()=>resolve('stopped'))));
 const session=new AgentSession({emit:(event:AgentEvent)=>events.push(event)} as any);
 const job=session.startNativeRecipe({runId:'native',goal:'scheduled recipe',execute});
 session.pause();await job;session.resume();
 expect(execute).toHaveBeenCalledTimes(1);expect(session.running).toBe(false);expect(session.paused).toBe(false);
 expect(events.filter(event=>event.type==='run.started')).toHaveLength(1);expect(events.at(-1)).toMatchObject({type:'run.finished',status:'stopped'});
});
