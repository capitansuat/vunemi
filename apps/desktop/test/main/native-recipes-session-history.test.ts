import {expect,it,vi} from 'vitest';
import type {RunOptions} from '@vunemi/agent-core';
const received=vi.hoisted(()=>[] as RunOptions[]);
vi.mock('@vunemi/agent-core',async original=>({
 ...await original<typeof import('@vunemi/agent-core')>(),
 createModel:(id:string)=>({id,contextWindow:async()=>20_000}),
 runAgent:async(options:RunOptions)=>{received.push(options);return {runId:'queued-model',status:'failed',detail:'synthetic',messages:[...(options.history??[]),{role:'user',content:options.goal}]};},
}));
const {AgentSession}=await import('../../src/main/session.js');

it('keeps a queued model message isolated after the recipe conversation boundary and native settlement',async()=>{
 received.length=0;const prepareModel=vi.fn(async()=>null);const onHistory=vi.fn();
 let finishNative!:(status:'done')=>void,settleNative!:()=>void;
 const session=new AgentSession({tools:{list:()=>[],get:()=>undefined} as never,emit:()=>{},authorize:async()=>({kind:'allow'}),onUntrustedOutput:()=>{},grants:new Set(),prepareModel,onHistory,
  onRunSettled:runId=>runId==='native'?new Promise<void>(resolve=>settleNative=resolve):Promise.resolve(),
 });
 session.load([{role:'user',content:'private prior conversation'}]);
 // The main native conversation callback clears Session before publishing its new conversation.
 session.load([]);
 const job=session.startNativeRecipe({runId:'native',goal:'scheduled document',execute:()=>new Promise(resolve=>finishNative=resolve)});
 expect(prepareModel).not.toHaveBeenCalled();
 session.submit('new conversation question','model');finishNative('done');await Promise.resolve();
 expect(session.running).toBe(true);expect(received).toHaveLength(0);expect(session.queued).toHaveLength(1);
 settleNative();await job;await vi.waitFor(()=>expect(received).toHaveLength(1));
 expect(received[0]!.history).toEqual([]);expect(received[0]!.goal).toBe('new conversation question');
 expect(JSON.stringify(onHistory.mock.calls)).not.toContain('private prior conversation');
});
