import {it,expect,vi} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import type {ChatModel} from '../src/provider.js';
import type {AgentEvent} from '../src/events.js';
function model():ChatModel {let count=0;return{id:'test:bound-context',async chat(){return{text:'',toolCalls:count++===0?[{id:'one',name:'bound_write',argumentsText:'{}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};}
it('passes trusted current run identity and cancellation into preapproval checks',async()=>{
 const seen:unknown[]=[];const events:AgentEvent[]=[];const dispatch=vi.fn(async()=> 'done');
 const tools=new ToolRegistry().register({name:'bound_write',description:'bound write',parameters:{type:'object',properties:{}},actionClass:'outbound',alwaysAsk:true,check:async(_args,...rest:unknown[])=>{seen.push(rest[0]);return rest[0]?null:'Missing trusted check context';},run:dispatch});
 const approve=vi.fn(async()=>({kind:'approve' as const}));
 await runAgent({goal:'Change only my selected page',tools,model:model(),emit:e=>events.push(e),requestApproval:approve});
 expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({runId:events.find(e=>e.type==='run.started')!.runId,userGoal:'Change only my selected page'});
 expect((seen[0] as {signal:AbortSignal}).signal).toBeInstanceOf(AbortSignal);expect((seen[0] as {assertToolActive:()=>void}).assertToolActive).toBeTypeOf('function');
 expect(approve).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);
});
it('rejects connector revocation during an asynchronous check before approval or dispatch',async()=>{
 const tools=new ToolRegistry();const dispatch=vi.fn(async()=> 'must not run');const approve=vi.fn(async()=>({kind:'approve' as const}));
 tools.register({name:'bound_write',description:'bound write',parameters:{type:'object',properties:{}},actionClass:'outbound',alwaysAsk:true,check:async(_args,...rest:unknown[])=>{tools.unregister('fixture');(rest[0] as {assertToolActive?:()=>void}|undefined)?.assertToolActive?.();return null;},run:dispatch},'fixture');
 await runAgent({goal:'Change only my selected page',tools,model:model(),emit(){},requestApproval:approve});
 expect(approve).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});
it('rechecks connector registration after an awaited check even if the tool does not invoke the callback',async()=>{
 const tools=new ToolRegistry(),dispatch=vi.fn(async()=> 'must not run'),approve=vi.fn(async()=>({kind:'approve' as const}));
 tools.register({name:'bound_write',description:'bound write',parameters:{type:'object',properties:{}},actionClass:'outbound',alwaysAsk:true,check:async()=>{await Promise.resolve();tools.unregister('fixture');return null;},run:dispatch},'fixture');
 await runAgent({goal:'Change only my selected page',tools,model:model(),emit(){},requestApproval:approve});
 expect(approve).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});

it('allows an unchanged offered-off tool to check and run once without enabling its source',async()=>{
 const tools=new ToolRegistry(), dispatch=vi.fn(async(_args,ctx)=>{ctx.assertToolActive();return 'done';});
 tools.register({name:'bound_write',description:'bound write',parameters:{type:'object',properties:{}},actionClass:'outbound',alwaysAsk:true,check:async(_args,ctx)=>{ctx!.assertToolActive();return null;},run:dispatch},'fixture');
 tools.setEnabled('fixture',false);
 const approve=vi.fn(async()=>({kind:'approve' as const}));
 await runAgent({goal:'Change only my selected page',tools,model:model(),emit(){},switchedOff:()=>({label:'Fixture'}),requestApproval:approve});
 expect(approve).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);expect(tools.isSwitchedOff('bound_write')).toBe(true);
});
it('refuses an offered-off tool whose source changes while its approval is pending',async()=>{
 const tools=new ToolRegistry(),dispatch=vi.fn(async(_args,ctx)=>{ctx.assertToolActive();return 'done';});
 tools.register({name:'bound_write',description:'bound write',parameters:{type:'object',properties:{}},actionClass:'outbound',alwaysAsk:true,check:async(_args,ctx)=>{ctx!.assertToolActive();return null;},run:dispatch},'fixture');
 tools.setEnabled('fixture',false);
 const approve=vi.fn(async()=>{tools.unregister('fixture');return {kind:'approve' as const};});
 await runAgent({goal:'Change only my selected page',tools,model:model(),emit(){},switchedOff:()=>({label:'Fixture'}),requestApproval:approve});
 expect(approve).toHaveBeenCalledTimes(1);expect(dispatch).not.toHaveBeenCalled();
});
