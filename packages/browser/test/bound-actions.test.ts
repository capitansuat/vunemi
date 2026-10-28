import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BoundActions} from '../src/bound-actions.js';
function fixture(){
 const path=join(mkdtempSync(join(tmpdir(),'bound-browser-')),'operations.jsonl');
 let state={frameId:'frame',loaderId:'doc1',url:'https://example.com/fixture',width:800,height:600,scale:1,scrollX:0,scrollY:0};
 const screenshot=vi.fn(async()=>Buffer.from('first image'));const visual=vi.fn(async()=>({'1':'canvas-first'}));
 const perform=vi.fn(async()=>{}),release=vi.fn(async()=>{});
 const driver={strictState:async()=>({...state}),strictPrepare:async()=>({ref:1,box:[10,10,200,100]}),strictPerform:perform,strictRelease:release,strictScreenshot:screenshot,strictVisualState:visual,strictReadback:async()=>({text:'actual fresh state',scrollX:0,scrollY:0,refs:[1,2],title:'Fixture',labels:[] as Array<{ref:number;role:string;name:string}>})};
 let host={foregroundPid:12,cursor:{x:10,y:20},unlocked:true};
 const adapter={targetId:'target',ownerId:'owned-instance',kind:'managed-browser' as const,headless:true as const,driver,assertOwned:async()=>{}};
 const actions=new BoundActions({operationJournalPath:path,observeHost:async()=>structuredClone(host)},async()=>adapter);
 return {actions,adapter,path,perform,release,screenshot,visual,changeDocument:()=>{state={...state,loaderId:'doc2'};},lock:()=>{host={...host,unlocked:false};},moveHost:()=>{host={...host,foregroundPid:99};}};
}
describe('bound browser dispatch',()=>{
 it('binds actual target/document and journals dispatch before fresh readback',async()=>{
  const f=fixture(),b=await f.actions.observe('run');const args={bindingId:b.bindingId,action:'click' as const,ref:1};
  await f.actions.check(args,'run');const receipt=await f.actions.act(args,{runId:'run',signal:new AbortController().signal});
  expect(f.perform).toHaveBeenCalledTimes(1);expect(receipt.delivery).toBe('delivered');expect(receipt.readback.text).toBe('actual fresh state');
  expect(readFileSync(f.path,'utf8').trim().split('\n').map(x=>JSON.parse(x).phase)).toEqual(['prepared','dispatched','result']);
 });
 it('rejects wrong run and changed document before dispatch',async()=>{
  const f=fixture(),b=await f.actions.observe('run'),args={bindingId:b.bindingId,action:'click' as const,ref:1};
  await expect(f.actions.check(args,'foreign')).rejects.toThrow(/owner|run/i);await f.actions.check(args,'run');f.changeDocument();
  await expect(f.actions.act(args,{runId:'run',signal:new AbortController().signal})).rejects.toThrow(/changed|stale/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('requires durable journal and verified host before dispatch',async()=>{
  const f=fixture(),b=await f.actions.observe('run'),a={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(a,'run');f.lock();
  await expect(f.actions.act(a,{runId:'run',signal:new AbortController().signal})).rejects.toThrow(/locked|host/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('persists unknown delivery and refuses another operation after host changes',async()=>{
  const f=fixture(),b=await f.actions.observe('run'),a={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(a,'run');f.perform.mockImplementationOnce(async()=>{f.moveHost();});
  await expect(f.actions.act(a,{runId:'run',signal:new AbortController().signal})).rejects.toMatchObject({deliveryUnknown:true});
  await expect(f.actions.check(a,'run')).rejects.toThrow(/unknown|blocked|used/i);expect(f.perform).toHaveBeenCalledTimes(1);
  expect(readFileSync(f.path,'utf8')).toContain('unknown');
 });
 it('releaseRun waits for actual in-flight settlement and never replays',async()=>{
  const f=fixture(),b=await f.actions.observe('run'),a={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(a,'run');
  let finish!:()=>void;f.perform.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;}));
  const pending=f.actions.act(a,{runId:'run',signal:new AbortController().signal});await vi.waitFor(()=>expect(f.perform).toHaveBeenCalledTimes(1));
  let settled=false;const release=f.actions.releaseRun('run').then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);finish();await pending;await release;expect(settled).toBe(true);
  await expect(f.actions.check(a,'run')).rejects.toThrow(/closed|settled|used|owner/i);
 });
 it('refuses absent durable journal even with a valid host',async()=>{
  const f=fixture(),a=new BoundActions({observeHost:async()=>({foregroundPid:12,cursor:{x:1,y:2},unlocked:true})},async()=>f.adapter);
  const b=await a.observe('r');await expect(a.check({bindingId:b.bindingId,action:'click',ref:1},'r')).rejects.toThrow(/journal/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('refuses absent host observer before approval preparation',async()=>{
  const f=fixture(),a=new BoundActions({operationJournalPath:f.path},async()=>f.adapter),b=await a.observe('r');
  await expect(a.check({bindingId:b.bindingId,action:'click',ref:1},'r')).rejects.toThrow(/host/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('blocks an unknown target across journal reload with no TTL',async()=>{
  const f=fixture(),b=await f.actions.observe('r'),args={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(args,'r');f.perform.mockRejectedValueOnce(Error('disconnected'));
  await expect(f.actions.act(args,{runId:'r',signal:new AbortController().signal})).rejects.toMatchObject({deliveryUnknown:true});
  const recovered=new BoundActions({operationJournalPath:f.path},async()=>f.adapter),next=await recovered.observe('new');
  await expect(recovered.check({bindingId:next.bindingId,action:'click',ref:1},'new')).rejects.toThrow(/unknown|blocked/i);expect(f.perform).toHaveBeenCalledTimes(1);
 });
 it('rejects mutated approved arguments and missing screenshot for visual targets',async()=>{
  const f=fixture(),b=await f.actions.observe('r'),args={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(args,'r');args.ref=2;
  await expect(f.actions.act(args,{runId:'r',signal:new AbortController().signal})).rejects.toThrow(/checked|exact/i);
  await expect(f.actions.check({...args,x:20,y:20},'r')).rejects.toThrow(/screenshot/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('serializes writers on one exact target and never queues a second input',async()=>{
  const f=fixture(),b=await f.actions.observe('r'),args={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(args,'r');
  let finish!:()=>void;f.perform.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;}));const pending=f.actions.act(args,{runId:'r',signal:new AbortController().signal});await vi.waitFor(()=>expect(f.perform).toHaveBeenCalledTimes(1));
  const another=await f.actions.observe('other');await expect(f.actions.check({bindingId:another.bindingId,action:'click',ref:1},'other')).rejects.toThrow(/busy/i);
  finish();await pending;expect(f.perform).toHaveBeenCalledTimes(1);
 });

 it('yields before dispatch when the target host is already foreground or cannot be identified',async()=>{
  const f=fixture();const adapter={...f.adapter,headless:undefined,hostPid:12};
  const a=new BoundActions({operationJournalPath:f.path,observeHost:async()=>({foregroundPid:12,cursor:{x:0,y:0},unlocked:true})},async()=>adapter),b=await a.observe('r');
  await expect(a.check({bindingId:b.bindingId,action:'click',ref:1},'r')).rejects.toThrow(/foreground|takeover/i);
  adapter.hostPid=0;await expect(a.check({bindingId:b.bindingId,action:'click',ref:1},'r')).rejects.toThrow(/host|identity/i);expect(f.perform).not.toHaveBeenCalled();
 });

 it.each(['malformed','oversize','symlink','broken-symlink'])('contains %s journal errors without crashing the controller or dispatching',async(mode)=>{
  const f=fixture();let path=f.path;
  if(mode==='malformed')writeFileSync(path,'not json\n');
  if(mode==='oversize')writeFileSync(path,'x'.repeat(8_000_001));
  if(mode==='symlink'||mode==='broken-symlink'){if(mode==='symlink')writeFileSync(path,'');const link=path+'.link';symlinkSync(path,link);path=link;}
  let actions!:BoundActions;expect(()=>{actions=new BoundActions({operationJournalPath:path,observeHost:async()=>({foregroundPid:1,cursor:{x:0,y:0},unlocked:true})},async()=>f.adapter);}).not.toThrow();
  const b=await actions.observe('r');await expect(actions.check({bindingId:b.bindingId,action:'click',ref:1},'r')).rejects.toThrow(/journal/i);expect(f.perform).not.toHaveBeenCalled();
 });

 it('refuses changed screenshot pixels before canvas dispatch',async()=>{
  const f=fixture(),b=await f.actions.observe('r');await f.actions.screenshot(b.bindingId,'r');
  const args={bindingId:b.bindingId,action:'drag' as const,ref:1,x:20,y:20,toX:30,toY:30};await f.actions.check(args,'r');f.visual.mockResolvedValueOnce({'1':'changed canvas'});
  await expect(f.actions.act(args,{runId:'r',signal:new AbortController().signal})).rejects.toThrow(/screenshot changed/i);expect(f.perform).not.toHaveBeenCalled();
 });
 it('dispose closes all owners and waits before the backend can close',async()=>{
  const f=fixture(),b=await f.actions.observe('r'),args={bindingId:b.bindingId,action:'click' as const,ref:1};await f.actions.check(args,'r');let finish!:()=>void;
  f.perform.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;}));const pending=f.actions.act(args,{runId:'r',signal:new AbortController().signal});await vi.waitFor(()=>expect(f.perform).toHaveBeenCalledTimes(1));
  let closed=false;const disposal=f.actions.dispose().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);finish();await pending;await disposal;expect(closed).toBe(true);
  await expect(f.actions.observe('r')).rejects.toThrow(/owner/i);
 });

 it('ignores unrelated screenshot animation while checking exact observed canvas pixels',async()=>{
  const f=fixture(),b=await f.actions.observe('r');await f.actions.screenshot(b.bindingId,'r');
  const args={bindingId:b.bindingId,action:'drag' as const,ref:1,x:20,y:20,toX:30,toY:30};await f.actions.check(args,'r');f.screenshot.mockResolvedValueOnce(Buffer.from('unrelated scrollbar faded'));
  const result=await f.actions.act(args,{runId:'r',signal:new AbortController().signal});expect(result.delivery).toBe('delivered');expect(f.perform).toHaveBeenCalledTimes(1);
 });

 it('refuses a guessed ref absent from the exact returned observation',async()=>{
  const f=fixture(),b=await f.actions.observe('r');await expect(f.actions.check({bindingId:b.bindingId,action:'click',ref:999},'r')).rejects.toThrow(/not returned|observ/i);expect(f.perform).not.toHaveBeenCalled();
 });

 it('supports DOM ref-to-ref drag without requiring canvas screenshot coordinates',async()=>{
  const f=fixture(),b=await f.actions.observe('r'),args={bindingId:b.bindingId,action:'drag' as const,ref:1,toRef:2};await f.actions.check(args,'r');
  expect((await f.actions.act(args,{runId:'r',signal:new AbortController().signal})).delivery).toBe('delivered');
  const next=await f.actions.observe('r');await expect(f.actions.check({bindingId:next.bindingId,action:'drag',ref:1,toRef:999},'r')).rejects.toThrow(/observ|returned/i);
 });

 it('previews the actual cached source/destination labels and title without another RPC',async()=>{
  const f=fixture();vi.spyOn(f.adapter.driver,'strictReadback').mockResolvedValueOnce({text:'[1] Button "Real source"\n[2] Button "Real destination"',scrollX:0,scrollY:0,refs:[1,2],labels:[{ref:1,role:'button',name:'Real source'},{ref:2,role:'button',name:'Real destination'}],title:'Owned fixture title'});
  const b=await f.actions.observe('r'),prepare=vi.spyOn(f.adapter.driver,'strictPrepare');
  const preview=f.actions.preview({bindingId:b.bindingId,action:'drag',ref:1,toRef:2});expect(preview).toContain('Owned fixture title');expect(preview).toContain('Real source');expect(preview).toContain('Real destination');expect(preview).not.toContain('[1]');expect(prepare).not.toHaveBeenCalled();
 });

 it('never copies field values from cached AX outline into approval preview',async()=>{
  const f=fixture();vi.spyOn(f.adapter.driver,'strictReadback').mockResolvedValueOnce({text:'[1] textbox "Public label" value="PRIVATE_SECRET"',scrollX:0,scrollY:0,refs:[1],title:'Fixture',labels:[{ref:1,role:'textbox',name:'Public label'}]});
  const b=await f.actions.observe('r');const preview=f.actions.preview({bindingId:b.bindingId,action:'click',ref:1});expect(preview).toContain('Public label');expect(preview).not.toContain('PRIVATE_SECRET');expect(preview).not.toContain('value=');
 });

});
