import {describe,expect,it} from 'vitest';
import {createDesktopTools,Helper} from '../src/index.js';
import {ToolRegistry,toolSpecsOf,runAgent,tasksFromEvents} from '@vunemi/agent-core';
import type {ToolContext,ChatModel,AgentEvent,DesktopEvidence} from '@vunemi/agent-core';
class Bridge extends Helper {
  calls: {op:string;args:Record<string,unknown>}[]=[];
  value='old'; status='verified';
  ambiguous=false;
  transportFailure=false;
  constructor(){super('/not-used');}
  override async permissions(){return {accessibility:true,screenRecording:true,calendars:false,reminders:false};}
  override async apps(){return [{name:'TextEdit',bundleId:'com.apple.TextEdit',pid:42,frontmost:false}];}
  override async call(op:string,args:Record<string,unknown>={}){
    this.calls.push({op,args});
    if(op==='validate_background')return {pid:42,bundleId:'com.apple.TextEdit',processStartedAt:123,windowId:9,controlMode:'backgroundStrict'};
    if(op==='windows')return {windows:[{title:'local-fixture.txt',windowId:9},...(this.ambiguous?[{title:'local-fixture.txt',windowId:10}]:[])]};
    const observed=()=>({bundleId:'com.apple.TextEdit',processStartedAt:123,windowId:9,windowTitle:'local-fixture.txt',controlMode:'backgroundStrict',targets:[{ref:1,label:this.value,role:'AXTextArea',value:this.value,backgroundActions:['set-value']}]});
    if(op==='background_set_value'){if(args.expectedValue!==this.value)throw Error('Field changed; no input');this.value=String(args.text);if(this.transportFailure)throw Error('transport lost');return {...observed(),status:this.status,operationId:'native-op',backend:'ax',text:`[1] TextArea "${this.value}"`,inputValues:[this.value],snapshotId:'after',foregroundChanged:false};}
    if(op==='describe')return {...observed(),text:'[1] TextArea "old"',snapshotId:'before',count:1};
    throw new Error('unsupported transport operation');
  }
}
const ctx=():ToolContext=>({signal:new AbortController().signal,handoff:async()=>true,offerUndo(){},attach(){}});
describe('background desktop contracts',()=>{
 it('marks a lost native response uncertain without issuing the append again',async()=>{
  const bridge=new Bridge(),tools=createDesktopTools({helper:bridge});const proof:DesktopEvidence[]=[];const context={...ctx(),recordDesktopEvidence:(e:DesktopEvidence)=>proof.push(e)};
  const observed=JSON.parse(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'TextEdit'},context) as string);
  bridge.transportFailure=true;const tool=tools.find(t=>t.name==='desktop_background_append_text')!,args={targetId:observed.targets[0].targetId,text:'new'};
  await expect(tool.run(args,context)).rejects.toMatchObject({deliveryUnknown:true});
  await expect(tool.run(args,context)).rejects.toThrow(/observe|target/i);
  expect(bridge.value).toBe('oldnew');expect(proof.map(e=>e.kind)).toEqual(['observation']);
 });
 it('refuses a named observation when two windows have the requested title',async()=>{
  const bridge=new Bridge();bridge.ambiguous=true;const tool=createDesktopTools({helper:bridge}).find(t=>t.name==='desktop_background_describe')!;
  await expect(tool.run({app:'TextEdit',windowTitle:'local-fixture.txt'},ctx())).rejects.toThrow(/unique|ambiguous/i);
  expect(bridge.calls.some(c=>c.op==='describe')).toBe(false);
 });
 it('publishes exact-field native proof separately from the model-facing output',async()=>{
  const bridge=new Bridge(),receipts:DesktopEvidence[]=[];const context={...ctx(),recordDesktopEvidence:(e:DesktopEvidence)=>receipts.push(e)};
  const tools=createDesktopTools({helper:bridge,settleMs:0});
  const observed=JSON.parse(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'TextEdit'},context) as string);
  await tools.find(t=>t.name==='desktop_background_append_text')!.run({targetId:observed.targets[0].targetId,text:'İstanbul'},context);
  expect(receipts.map(e=>e.kind)).toEqual(['observation','verified-append']);
  expect(receipts[0]).toMatchObject({windowId:9,windowTitle:'local-fixture.txt',valueHash:'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4'});
  expect(receipts[1]).toMatchObject({beforeHash:receipts[0]!.valueHash,appendedText:'İstanbul',operationId:'native-op'});
  expect(receipts[1]!.valueHash).not.toBe(receipts[0]!.valueHash);
 });
 it('appends through an observed handle without model copies of labels or existing text',async()=>{
  const bridge=new Bridge();bridge.value='çığ\n';const tools=createDesktopTools({helper:bridge,settleMs:0});
  const observed=JSON.parse(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'TextEdit',windowId:9},ctx()) as string);
  const tool=tools.find(t=>t.name==='desktop_background_append_text')!;expect(tool).toBeDefined();
  const args={targetId:observed.targets[0].targetId,text:'İstanbul 👩‍💻.'};
  expect(await tool.preview!(args)).toContain('local-fixture.txt');
  await tool.check!(args);expect(tool.approvalScope).toBeUndefined();expect(tool.allowSessionApproval).toBeUndefined();
  await tool.run(args,ctx());expect(bridge.value).toBe('çığ\nİstanbul 👩‍💻.');
  expect(bridge.calls.find(c=>c.op==='background_set_value')?.args).toMatchObject({label:'çığ\n',expectedValue:'çığ\n',text:'çığ\nİstanbul 👩‍💻.'});
  await expect(tool.run(args,ctx())).rejects.toThrow(/observe|target/i);
 });
 it('rejects fabricated handles and preserves an edit made while approval is pending',async()=>{
  const bridge=new Bridge();const tools=createDesktopTools({helper:bridge,settleMs:0});const tool=tools.find(t=>t.name==='desktop_background_append_text')!;
  expect(tool).toBeDefined();await expect(tool.check!({targetId:'invented',text:'x'})).rejects.toThrow();expect(bridge.calls).toEqual([]);
  const observed=JSON.parse(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'TextEdit'},ctx()) as string);
  const args={targetId:observed.targets[0].targetId,text:'x'};await tool.check!(args);bridge.value='user edit';
  await expect(tool.run(args,ctx())).rejects.toThrow(/changed/);expect(bridge.value).toBe('user edit');
 });
 it('sends no append after Stop',async()=>{
  const bridge=new Bridge();const tools=createDesktopTools({helper:bridge,settleMs:0});const tool=tools.find(t=>t.name==='desktop_background_append_text')!;
  const observed=JSON.parse(await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'TextEdit'},ctx()) as string);
  const args={targetId:observed.targets[0].targetId,text:'x'};await tool.check!(args);
  const controller=new AbortController();controller.abort();await expect(tool.run(args,{...ctx(),signal:controller.signal})).rejects.toThrow(/Stopped/);
  expect(bridge.value).toBe('old');expect(bridge.calls.some(c=>c.op==='background_set_value')).toBe(false);
 });
 it('rejects a model foreground fallback in a background task before native delivery',async()=>{
  const bridge=new Bridge();const registry=new ToolRegistry();for(const tool of createDesktopTools({helper:bridge,settleMs:0}))registry.register(tool);
  expect(toolSpecsOf(registry,undefined,undefined,'TextEdit arka planda çalışsın').some(t=>t.name==='desktop_focus')).toBe(false);
  let turns=0;
  const model:ChatModel={id:'background-test',async chat(){turns++;return {text:turns>1?'Unsupported.':'',toolCalls:turns===1?[{id:'focus',name:'desktop_focus',argumentsText:'{"app":"TextEdit"}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
  const events:AgentEvent[]=[];
  await runAgent({goal:'TextEdit arka planda çalışsın',model,tools:registry,requestApproval:async()=>{throw new Error('A foreground fallback must never reach approval');},emit:e=>events.push(e),maxSteps:3});
  expect(bridge.calls).toEqual([]);
  expect(events.some(e=>e.type==='tool.finished' && !e.ok)).toBe(true);
  const original=tasksFromEvents(events)[0]!;
  turns=0;events.length=0;
  await runAgent({goal:'Devam et',resumeTask:original,model,tools:registry,emit:e=>events.push(e),requestApproval:async()=>{throw new Error('Continuation must retain background constraints');},maxSteps:3});
  expect(bridge.calls).toEqual([]);
  expect(events.some(e=>e.type==='tool.finished' && !e.ok)).toBe(true);
 });
 it('binds permission to the native window and separates foreground Always scope',async()=>{
  const bridge=new Bridge();const tool=createDesktopTools({helper:bridge,settleMs:0}).find(t=>t.name==='desktop_background_set_text');
  expect(tool).toBeDefined();
  const args={app:'TextEdit',snapshotId:'before',ref:1,label:'old',expectedValue:'old',text:'new'};
  expect(tool!.approvalScope?.(args)).toBeUndefined();expect(await tool!.check?.(args)).toBeNull();
  expect(tool!.approvalScope).toBeUndefined();expect(tool!.allowSessionApproval).toBeUndefined();
  expect(await tool!.run(args,ctx())).toContain('verified');
  expect(bridge.value).toBe('new');expect(bridge.calls.map(c=>c.op)).toEqual(['validate_background','validate_background','background_set_value']);
 });
 it('fails an unknown delivery instead of claiming a verified write',async()=>{
  const bridge=new Bridge();bridge.status='unknown';
  const tool=createDesktopTools({helper:bridge,settleMs:0}).find(t=>t.name==='desktop_background_set_text');
  expect(tool).toBeDefined();
  await expect(tool!.run({app:'TextEdit',snapshotId:'before',ref:1,label:'old',expectedValue:'old',text:'new'},ctx())).rejects.toThrow(/observe|unknown/i);
 });
 it('requires an explicit observed value and snapshot before delivery',async()=>{
  const bridge=new Bridge();const tool=createDesktopTools({helper:bridge,settleMs:0}).find(t=>t.name==='desktop_background_set_text');
  expect(tool).toBeDefined();
  await expect(tool!.run({app:'TextEdit',ref:1,label:'old',text:'new'},ctx())).rejects.toThrow();expect(bridge.value).toBe('old');
 });
 it('observes without an activation fallback',async()=>{
  const bridge=new Bridge();const tool=createDesktopTools({helper:bridge,settleMs:0}).find(t=>t.name==='desktop_background_describe');expect(tool).toBeDefined();
  expect(await tool!.run({app:'TextEdit',windowId:9},ctx())).toContain('before');
  expect(bridge.calls[0]).toEqual({op:'describe',args:{app:'42',part:'window',windowId:9,background:true}});
 });
});
