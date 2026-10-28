/** Real AgentSession/runAgent lifecycle with controlled model transport; no mocked runAgent. */
import {expect,it,vi} from 'vitest';
// This suite isolates real helper transport settlement; OS admission has separate native subprocess tests.
vi.mock('../../../../packages/mac/src/journal-coordinator.js',()=>({withJournalAdmission:async(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {ToolRegistry,type AgentEvent,type ChatModel} from '@vunemi/agent-core';
const state=vi.hoisted(()=>({models:new Map<string,unknown>()}));
vi.mock('@vunemi/agent-core',async load=>{const real=await load<typeof import('@vunemi/agent-core')>();return {...real,createModel:(spec:string)=>{const model=state.models.get(spec);if(!model)throw Error('Model unavailable');return model}}});
const {AgentSession}=await import('../../src/main/session.js');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}};
const usage={promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1};
function model(spec:string,chat:ChatModel['chat']){state.models.set(spec,{id:spec,contextWindow:async()=>32000,chat} satisfies ChatModel)}
function session(settled:(id:string)=>Promise<void>,events:AgentEvent[]=[],tools=new ToolRegistry()){return new AgentSession({tools,emit:e=>events.push(e),authorize:async()=>({kind:'allow'}),onUntrustedOutput:()=>{},grants:new Set(),onRunSettled:settled})}
it('keeps a finished run active and queued work waiting until its actual owner settles',async()=>{
 model('settlement-done',async()=>({text:'Hello.',toolCalls:[],usage}));
 const gate=deferred(),entered=deferred(),events:AgentEvent[]=[],owners:string[]=[];
 const s=session(async id=>{owners.push(id);if(owners.length===1){entered.resolve();await gate.promise}},events);
 const first=s.start('Hello','settlement-done');await entered.promise;
 const firstId=events.find(e=>e.type==='run.started')!.runId;expect(owners).toEqual([firstId]);expect(events.some(e=>e.type==='run.finished')).toBe(true);expect(s.running).toBe(true);
 await expect(s.start('Second','settlement-done')).rejects.toThrow(/already/);
 const queued=s.submit('Queued hello','settlement-done');expect(queued).toBeTruthy();expect(events.filter(e=>e.type==='run.started')).toHaveLength(1);
 gate.resolve();expect(await first).toBe('done');
 await vi.waitFor(()=>expect(owners).toHaveLength(2));expect(new Set(owners).size).toBe(2);
});
it('Stop does not free the session or skip owner settlement',async()=>{
 const talking=deferred();model('settlement-stop',async req=>{talking.resolve();await new Promise<void>(resolve=>req.signal?.addEventListener('abort',()=>resolve(),{once:true}));throw new DOMException('Stopped','AbortError')});
 const entered=deferred(),gate=deferred(),owners:string[]=[],events:AgentEvent[]=[];
 const s=session(async id=>{owners.push(id);entered.resolve();await gate.promise},events);const done=s.start('Hello','settlement-stop');await talking.promise;s.stop();await entered.promise;
 expect(s.running).toBe(true);expect(owners).toEqual([events.find(e=>e.type==='run.started')!.runId]);gate.resolve();expect(await done).toBe('stopped');expect(s.running).toBe(false);
});
it('cleans session state if owner settlement fails without claiming its resource was unlocked',async()=>{
 model('settlement-error',async()=>({text:'Hello.',toolCalls:[],usage}));const s=session(async()=>{throw Error('Resource remains blocked')});await expect(s.start('Hello','settlement-error')).rejects.toThrow('Resource remains blocked');expect(s.running).toBe(false);
});
it('does not release an invented owner if a run never started',async()=>{
 const settle=vi.fn(async()=>{}),s=session(settle);await expect(s.start('Hello','absent-model')).rejects.toThrow('Model unavailable');expect(settle).not.toHaveBeenCalled();expect(s.running).toBe(false);
});

it('settles the same real run owner supplied to tool execution context',async()=>{
 let calls=0,executedOwner:string|undefined;model('settlement-tool',async()=>++calls===1?{text:'',toolCalls:[{id:'probe',name:'lease_scope_probe',argumentsText:'{}'}],usage}:{text:'Read complete.',toolCalls:[],usage});
 const tools=new ToolRegistry().register({name:'lease_scope_probe',description:'Read local scope',parameters:{type:'object',properties:{}},actionClass:'read',run:async(_args,ctx)=>{executedOwner=ctx.runId;return 'Read complete.'}});
 const settled:string[]=[],s=session(async id=>{settled.push(id)},[],tools);expect(await s.start('Read local scope','settlement-tool')).toBe('done');expect(executedOwner).toBeTruthy();expect(settled).toEqual([executedOwner]);
});
it('Stop keeps real helper transport exclusive through child exit and retains an unknown target lock',async()=>{
 const {Helper}=await import('@vunemi/mac');const {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(join(tmpdir(),'session-helper-settle-')),log=join(dir,'events.txt'),binary=join(dir,'helper.cjs'),exitGate=join(dir,'allow-exit');
 writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');const log=${JSON.stringify(log)};const note=s=>{try{fs.appendFileSync(log,s+'\\n')}catch{}};process.on('SIGTERM',()=>{note('terminating');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitGate)})){note('exited');process.exit(0)}},10)});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);note('request');setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{status:'completed'}})+'\\n'),60000)});`,{mode:0o755});
 const helper=new Helper(binary,{operationJournalPath:join(dir,'journal.json')}),target={bundleId:'test.target',pid:10,processStartedAt:20,windowId:30};
 let calls=0;model('settlement-helper',async()=>++calls===1?{text:'',toolCalls:[{id:'native',name:'lease_scope_probe',argumentsText:'{}'}],usage}:{text:'Read complete.',toolCalls:[],usage});
 const owners:string[]=[],events:AgentEvent[]=[],tools=new ToolRegistry().register({name:'lease_scope_probe',description:'Probe a synthetic native helper',parameters:{type:'object',properties:{}},actionClass:'read',run:async(_args,ctx)=>String(await helper.call('background_press',{app:'10'},{ownerRunId:ctx.runId,target,signal:ctx.signal}))});
 const s=session(async id=>{owners.push(id);await helper.releaseRun(id)},events,tools);
 try{
  const done=s.start('Read local scope','settlement-helper');await vi.waitFor(()=>expect(existsSync(log)&&readFileSync(log,'utf8').includes('request')).toBe(true));s.stop();
  expect(s.running).toBe(true);await expect(helper.call('apps')).rejects.toMatchObject({noInputSent:true,reasonCode:'helper-busy'});
  await vi.waitFor(()=>expect(readFileSync(log,'utf8')).toContain('terminating'));expect(s.running).toBe(true);writeFileSync(exitGate,'settle');
  expect(await done).toBe('stopped');expect(readFileSync(log,'utf8')).toContain('exited');expect(owners).toEqual([events.find(e=>e.type==='run.started')!.runId]);
  await expect(helper.call('background_press',{app:'10'},{ownerRunId:'another-run',target})).rejects.toMatchObject({noInputSent:true,reasonCode:'delivery-blocked'});
 }finally{writeFileSync(exitGate,'settle');helper.dispose();await vi.waitFor(()=>expect(readFileSync(log,'utf8')).toContain('exited'));rmSync(dir,{recursive:true,force:true})}
});
it('a normally settled session releases its known helper target for a different run',async()=>{
 const {Helper}=await import('@vunemi/mac');const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const dir=mkdtempSync(join(tmpdir(),'session-helper-known-')),binary=join(dir,'helper.cjs');
 writeFileSync(binary,`#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{status:'delivered'}})+'\\n')});`,{mode:0o755});
 const helper=new Helper(binary,{operationJournalPath:join(dir,'journal.json')}),target={bundleId:'test.known',pid:11,processStartedAt:22,windowId:33};let calls=0;
 model('settlement-known-helper',async()=>++calls===1?{text:'',toolCalls:[{id:'native',name:'lease_scope_probe',argumentsText:'{}'}],usage}:{text:'Read complete.',toolCalls:[],usage});
 const tools=new ToolRegistry().register({name:'lease_scope_probe',description:'Probe synthetic native helper',parameters:{type:'object',properties:{}},actionClass:'read',run:async(_args,ctx)=>String(await helper.call('background_press',{app:'11'},{ownerRunId:ctx.runId,target,signal:ctx.signal}))});
 try{const s=session(id=>helper.releaseRun(id),[],tools);expect(await s.start('Read local scope','settlement-known-helper')).toBe('done');expect(await helper.call('background_press',{app:'11'},{ownerRunId:'different-known-run',target})).toMatchObject({status:'delivered'});await helper.releaseRun('different-known-run')}finally{helper.dispose();rmSync(dir,{recursive:true,force:true})}
});
