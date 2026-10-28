import {describe,it,expect,vi} from 'vitest';
import {runAgent,toolSpecsOf} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import type {ChatModel,ToolCall} from '../src/provider.js';
import {tasksFromEvents} from '../src/tasks.js';
import type {AgentEvent} from '../src/events.js';
const goal='Arka planda All Clear düğmesine bir kez bas; odağı değiştirme. desktop_background_describe ile doğrula.';
function setup(names:string[],failCheck=false){
 const dispatch=vi.fn(async()=> 'actual result'),check=vi.fn(async()=>failCheck?'Target application is closed':null),preview=vi.fn(async()=> 'preview');
 const tools=new ToolRegistry();
 for(const name of names)tools.register({name,description:name,parameters:{type:'object',properties:{}},actionClass:name==='desktop_background_describe'?'read':'write-local',preview,check,run:dispatch});
 return {tools,dispatch,check,preview};
}
function model(turns:string[][]){let index=0;const calls=vi.fn();const model:ChatModel={id:'test:background',async chat(req){calls(req);return {text:index>=turns.length?'done':'',toolCalls:(turns[index++]??[]).map((name,n):ToolCall=>({id:`${index}-${n}`,name,argumentsText:'{}'})),usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};return {model,calls};}
async function run(names:string[][],fixture:ReturnType<typeof setup>,other={}){const m=model(names),events:AgentEvent[]=[];const approve=vi.fn(async()=>({kind:'approve' as const}));const result=await runAgent({goal,tools:fixture.tools,model:m.model,emit:e=>events.push(e),requestApproval:approve,...other});return {...m,events,result,approve};}
describe('background-only model boundary',()=>{
 it('hides generic app/foreground fallback but keeps independent authorized tools visible',()=>{
  const f=setup(['app_command','desktop_focus','desktop_background_describe','document_make','files_read','calendar_list','web_search']);
  expect(toolSpecsOf(f.tools,undefined,undefined,goal).map(t=>t.name)).toEqual(['desktop_background_describe','document_make','files_read','calendar_list','web_search']);
  expect(toolSpecsOf(f.tools,undefined,undefined,'Create a Craft document in the background').some(t=>t.name==='document_make')).toBe(true);
 });
 it('blocks fallback before preview/check/approval and stops the same tool batch',async()=>{
  const f=setup(['app_command','desktop_background_click']);const r=await run([['app_command','desktop_background_click']],f);
  expect(f.preview).not.toHaveBeenCalled();expect(f.check).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();expect(r.result.status).toBe('stopped');
 });
 it('closed target fails once without retry or fallback and retains the failed operation',async()=>{
  const f=setup(['desktop_background_click','app_command'],true);const r=await run([['desktop_background_click'],['app_command']],f);
  expect(r.calls).toHaveBeenCalledTimes(1);expect(f.dispatch).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();expect(r.result.status).toBe('stopped');
  expect(r.events.find(e=>e.type==='tool.finished')).toMatchObject({ok:false});
  expect(r.events.some(e=>e.type==='tool.finished'&&e.retryable===true)).toBe(false);
 });
 it('permits a real observe, press, readback sequence and multiple arithmetic presses',async()=>{
  const f=setup(['desktop_background_describe','desktop_background_click']);const r=await run([['desktop_background_describe'],['desktop_background_click'],['desktop_background_click'],['desktop_background_describe']],f,{goal:'Calculate 12+7 in Calculator in the background'});
  expect(f.dispatch).toHaveBeenCalledTimes(4);expect(r.result.status).toBe('done');
 });
 it('enforces the original background constraint on resumed tool_run calls',async()=>{
  const f=setup(['app_command']);const prior=tasksFromEvents([{type:'run.started',runId:'old',goal,model:'test:prior',at:1}])[0]!;
  const events:AgentEvent[]=[];const approve=vi.fn(async()=>({kind:'approve' as const}));
  const wrapped:ChatModel={id:'test:wrapped',async chat(){return {text:'',toolCalls:[{id:'wrapped',name:'tool_run',argumentsText:JSON.stringify({name:'app_command',arguments:{command:'run'}})}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
  const result=await runAgent({goal:'Continue',resumeTask:prior,tools:f.tools,model:wrapped,areas:[{id:'apps',summary:'apps'}],shownTools:new Set(),pickAreas:async()=>[],emit:e=>events.push(e),requestApproval:approve});
  expect(result.status).toBe('stopped');expect(f.preview).not.toHaveBeenCalled();expect(f.check).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(approve).not.toHaveBeenCalled();
  expect(events.some(e=>e.type==='tool.proposed'&&e.tool==='app_command')).toBe(true);
 });
 it('unknown delivery preserves evidence and never dispatches the next fallback',async()=>{
  const f=setup(['desktop_background_click','app_command']);f.dispatch.mockRejectedValueOnce(Object.assign(new Error('delivery uncertain'),{deliveryUnknown:true}));
  const r=await run([['desktop_background_click','app_command']],f);
  expect(r.result.status).toBe('stopped');expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(r.events.some(e=>e.type==='tool.finished'&&e.deliveryUnknown===true)).toBe(true);
 });
 it('enforces an explicit single-button request without limiting arithmetic',async()=>{
  const f=setup(['desktop_background_click']);const r=await run([['desktop_background_click','desktop_background_click']],f);
  expect(f.dispatch).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('stopped');
 });

 it('does not block independent background file/Craft/calendar/web work at runtime',async()=>{
  const f=setup(['document_make','files_write','calendar_create','web_search','system_run']);
  const r=await run([['document_make','files_write','calendar_create','web_search','system_run']],f,{goal:'Prepare a Craft report in the background and update my calendar using researched web facts'});
  expect(f.dispatch).toHaveBeenCalledTimes(5);expect(r.result.status).toBe('done');
 });

 it('does not substitute another background mutation after the one requested press',async()=>{
  const f=setup(['desktop_background_click','desktop_background_set_text','files_write']);
  const r=await run([['desktop_background_click','desktop_background_set_text','files_write']],f);
  expect(f.dispatch).toHaveBeenCalledTimes(1);expect(f.check).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('stopped');
 });

 it('preserves the allowlisted file converter inside a native background goal',async()=>{
  const f=setup(['system_run']);const r=await run([['system_run']],f,{goal:'Calculator arka planda çalışırken dosyayı PDF çevir'});
  expect(f.dispatch).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('done');
  expect(toolSpecsOf(f.tools,undefined,undefined,'TextEdit background task and convert this file').map(t=>t.name)).toEqual(['system_run']);
 });
 it('blocks unknown-focus shortcuts for background Notes without app-name heuristics',async()=>{
  const f=setup(['shortcuts_run']);const r=await run([['shortcuts_run']],f,{goal:'In Notes run the shortcut in the background without changing focus'});
  expect(toolSpecsOf(f.tools,undefined,undefined,'Keynote in the background')).toEqual([]);
  expect(f.preview).not.toHaveBeenCalled();expect(f.check).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();expect(r.result.status).toBe('stopped');
 });

 it('requires the real initial read schema and fails closed on prose-only generation',async()=>{
  const f=setup(['desktop_background_describe','desktop_background_click']);
  const r=await run([[]],f,{goal:`Calculator ${goal}`});
  expect(r.calls).toHaveBeenCalledTimes(1);
  expect(r.calls.mock.calls[0]![0].toolChoice).toEqual({name:'desktop_background_describe'});
  expect(r.result.status).toBe('failed');expect(f.dispatch).not.toHaveBeenCalled();
 });
 it('requires the direct observation schema even when area tools otherwise use tool_run',async()=>{
  const f=setup(['desktop_background_describe']);
  const r=await run([['desktop_background_describe']],f,{goal:`Calculator ${goal}`,areas:[{id:'desktop',summary:'Mac windows'}],shownTools:new Set(),pickAreas:async()=>[]});
  expect(r.calls.mock.calls[0]![0].toolChoice).toEqual({name:'desktop_background_describe'});
  expect(r.calls.mock.calls[0]![0].tools.some((t:{name:string})=>t.name==='desktop_background_describe')).toBe(true);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
 });

 it('rejects an ignored required choice returning a mutation before dispatch or approval',async()=>{
  const f=setup(['desktop_background_describe','desktop_background_click']);
  const r=await run([['desktop_background_click']],f,{goal:`Calculator ${goal}`});
  expect(r.result.status).toBe('failed');expect(f.preview).not.toHaveBeenCalled();expect(f.check).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();
  expect(r.events.some(e=>e.type==='tool.proposed')).toBe(false);
 });

 it('advertises only the required real read during the initial generation and restores normal tools afterwards',async()=>{
  const f=setup(['desktop_background_describe','desktop_background_click','desktop_apps']);
  const r=await run([['desktop_background_describe'],[]],f,{goal:`Calculator ${goal}`});
  expect(r.calls.mock.calls[0]![0].tools.map((t:{name:string})=>t.name)).toEqual(['desktop_background_describe']);
  expect(r.calls.mock.calls[1]![0].toolChoice).toBeUndefined();
  expect(r.calls.mock.calls[1]![0].tools.map((t:{name:string})=>t.name)).toContain('desktop_apps');
 });

 it.each([
  {calls:[],reason:'no-call',names:[]},
  {calls:['desktop_apps'],reason:'wrong-tool',names:['desktop_apps']},
  {calls:['desktop_background_describe','private-value-not-a-tool'],reason:'multiple-calls',names:['desktop_background_describe','unrecognized']},
 ])('records sanitized $reason diagnostics without dispatch or private text',async({calls,reason,names})=>{
  const f=setup(['desktop_background_describe','desktop_apps']);
  const r=await run([calls],f,{goal:`Calculator ${goal}`});
  expect(r.result.status).toBe('failed');expect(f.dispatch).not.toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.check).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();
  expect(r.events.some(e=>e.type==='tool.proposed')).toBe(false);
  const finished=r.events.find(e=>e.type==='run.finished');
  expect(finished).toMatchObject({toolChoiceFailure:{reason,returnedCalls:calls.length,tools:names}});
  expect(JSON.stringify(finished)).not.toContain('private-value-not-a-tool');
  expect(r.result.detail).not.toContain('tool-choice');
 });

});

const newNativeMutations=['desktop_background_scroll_position','desktop_background_menu_open','desktop_background_menu_select','desktop_background_drag','page_target_act'];
it.each(newNativeMutations)('stops after a refused new native mutation %s without fallback or retry',async name=>{
 const f=setup([name,'app_command'],true);const r=await run([[name],['app_command']],f,{goal:'Use the selected native window in the background'});
 expect(r.calls).toHaveBeenCalledTimes(1);expect(f.dispatch).not.toHaveBeenCalled();expect(r.result.status).toBe('stopped');
 expect(r.events.some(e=>e.type==='tool.finished'&&e.retryable===true)).toBe(false);
});
it.each(newNativeMutations)('does not allow %s to evade the single requested native input cap',async name=>{
 const f=setup(['desktop_background_click',name]);const r=await run([['desktop_background_click',name]],f);
 expect(f.dispatch).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('stopped');
});

it('requires bound browser input for explicit background work while keeping web research and observation',async()=>{
 const legacy=['page_click','page_type','page_select','page_press','page_scroll','tabs_focus'];
 const f=setup([...legacy,'page_search','page_goto','page_read','page_target_observe','page_target_act']);
 expect(toolSpecsOf(f.tools,undefined,undefined,'Research the web and manipulate this canvas in the background').map(t=>t.name)).toEqual(['page_search','page_goto','page_read','page_target_observe','page_target_act']);
 const r=await run([['page_click']],f,{goal:'Click this canvas in the background'});
 expect(f.check).not.toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(r.approve).not.toHaveBeenCalled();expect(r.result.status).toBe('stopped');
 expect(toolSpecsOf(f.tools,undefined,undefined,'Click the normal web page').some(t=>t.name==='page_click')).toBe(true);
});
it.each(['Press the button once in the background, then drag the canvas.','Arka planda düğmeye bir kez bas, sonra canvası sürükle.'])('allows the explicitly requested second action in a compound goal: %s',async compound=>{
 const f=setup(['desktop_background_click','page_target_act']);const r=await run([['desktop_background_click','page_target_act']],f,{goal:compound});
 expect(f.dispatch).toHaveBeenCalledTimes(2);expect(r.result.status).toBe('done');
});
it('does not treat a prohibition on dragging as a requested second action',async()=>{
 const f=setup(['desktop_background_click','page_target_act']);const r=await run([['desktop_background_click','page_target_act']],f,{goal:'Press the button once in the background, then do not scroll or drag.'});
 expect(f.dispatch).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('stopped');
});
it('semantic file and document moves retain the background no-retry boundary',async()=>{for(const name of ['files_move','desktop_document_move']){const f=setup([name],true);const r=await run([[name],[name]],f,{goal:'Move the requested file or selected text in the background; do not change focus.'});expect(f.dispatch).not.toHaveBeenCalled();expect(r.calls).toHaveBeenCalledTimes(1);expect(r.result.status).toBe('stopped');}});
