import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const platform=vi.hoisted(()=>({directory:'',idle:20,state:'active',wake:undefined as undefined|(()=>void),execute:vi.fn()}));
vi.mock('electron',()=>({app:{getPath:()=>platform.directory},powerMonitor:{getSystemIdleTime:()=>platform.idle,getSystemIdleState:()=>platform.state,on:(_event:string,fn:()=>void)=>{platform.wake=fn;}}}));
vi.mock('@vunemi/mac',()=>({NativeRecipeDriver:class{execute(...args:unknown[]){return platform.execute(...args);}}}));
const {installNativeRecipes}=await import('../../src/main/native-recipes/install.js');
let runtime:ReturnType<typeof installNativeRecipes>|undefined;

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1_000_000);platform.directory=mkdtempSync(join(tmpdir(),'native-install-'));platform.idle=20;platform.state='active';platform.execute.mockReset();platform.execute.mockResolvedValue({status:'no-input',dispatchIds:[],reasonCode:'synthetic-no-input'});});
afterEach(()=>{runtime?.dispose();runtime=undefined;vi.useRealTimers();rmSync(platform.directory,{recursive:true,force:true});});

async function setup(){
 const helperPath=join(platform.directory,'helper');writeFileSync(helperPath,'synthetic-helper');
 const revision=createHash('sha256').update('synthetic-helper').digest('hex');
 const environment=vi.fn(async()=>({uid:process.getuid!(),securitySessionId:2}));
 const startNativeRecipe=vi.fn(async(req:any)=>req.execute(new AbortController().signal,()=>{}));
 const conversation=vi.fn();
 const roots={list:()=>['/tmp'],resolve:(path:string)=>path};
 const sentinel={currentPolicy:{read:'auto',outbound:'ask', 'write-local':'ask'},check:vi.fn(()=>({kind:'allow'}))};
 runtime=installNativeRecipes({helper:{call:environment,blockTarget:vi.fn()} as any,helperPath,roots:roots as any,session:{running:false,queued:[],startNativeRecipe} as any,sentinel:sentinel as any,connectors:{isOn:()=>true,isPartOn:()=>true},locked:()=>false,handle:()=>{},send:()=>{},conversation});
 await runtime.controller.synchronize();
 const binding={target:{path:'/tmp/fixture.txt',pid:2,windowId:3,bundleId:'com.apple.TextEdit' as const,startSec:'1',startUsec:'2',parentDevice:'1',parentInode:'2'},version:{device:'1',inode:'3',size:'1',mtimeNs:'1',ctimeNs:'1',sha256:'abc'},textUnits:1,uid:process.getuid!(),securitySessionId:2,helperRevision:revision};
 const owner={setupSessionId:'setup',setupCallId:'call'};
 const offer=runtime.store.offer(owner,binding,{recipeId:'textedit.append-save.v1',target:binding.target,literal:'X',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,slots:[]},[1_120_000,1_240_000],Date.now());
 runtime.store.approve(offer.offerId,offer.revision,owner);
 return {environment,startNativeRecipe,conversation,roots,sentinel};
}

it('consumes a due slot when security metadata fails and never replays it after recovery',async()=>{
 const {environment,startNativeRecipe,conversation}=await setup();environment.mockRejectedValueOnce(Error('security session unavailable'));
 vi.setSystemTime(1_115_000);await vi.advanceTimersByTimeAsync(5000);
 expect(runtime!.store.snapshot().recipes[0]).toMatchObject({remainingSlots:1,slots:[{status:'skipped',reason:'busy'},{status:'scheduled'}]});
 await vi.advanceTimersByTimeAsync(5000);platform.wake?.();await vi.advanceTimersByTimeAsync(0);
 expect(startNativeRecipe).not.toHaveBeenCalled();expect(platform.execute).not.toHaveBeenCalled();expect(conversation).not.toHaveBeenCalled();
 expect(runtime!.store.snapshot().recipes[0]!.remainingSlots).toBe(1);
});
it.each(['recent-input','locked'] as const)('consumes the %s slot instead of waiting for an idle unlocked desktop',async reason=>{
 const {startNativeRecipe}=await setup();if(reason==='recent-input')platform.idle=2;else platform.state='locked';
 vi.setSystemTime(1_115_000);await vi.advanceTimersByTimeAsync(5000);
 expect(runtime!.store.snapshot().recipes[0]!.slots[0]!.status).toBe('skipped');
 platform.idle=20;platform.state='active';await vi.advanceTimersByTimeAsync(5000);
 expect(startNativeRecipe).not.toHaveBeenCalled();expect(platform.execute).not.toHaveBeenCalled();
});
it('admits a future slot independently after a skipped metadata failure',async()=>{
 const {environment,startNativeRecipe}=await setup();environment.mockRejectedValueOnce(Error('unavailable'));
 vi.setSystemTime(1_115_000);await vi.advanceTimersByTimeAsync(5000);
 vi.setSystemTime(1_235_000);await vi.advanceTimersByTimeAsync(5000);
 expect(startNativeRecipe).toHaveBeenCalledTimes(1);expect(platform.execute).toHaveBeenCalledTimes(1);
 expect(runtime!.store.snapshot().recipes[0]).toMatchObject({remainingSlots:0,slots:[{status:'skipped'},{status:'skipped',reason:'synthetic-no-input'}]});
});
it.each(['roots','policy'] as const)('ends active authority synchronously when %s changes between native boundaries',async changed=>{
 const {roots,sentinel,startNativeRecipe}=await setup();const dispatch=vi.fn();
 platform.execute.mockImplementationOnce(async(_binding,_literal,_backup,context)=>{
  if(changed==='roots')roots.list=()=>['/changed'];else sentinel.currentPolicy.read='deny';
  context.assertActive();dispatch();return {status:'no-input',dispatchIds:[]};
 });
 vi.setSystemTime(1_115_000);await vi.advanceTimersByTimeAsync(5000);
 expect(startNativeRecipe).toHaveBeenCalledTimes(1);expect(dispatch).not.toHaveBeenCalled();
 expect(runtime!.store.snapshot().recipes[0]).toMatchObject({authorityStatus:'reapproval-required',remainingSlots:1,slots:[{status:'skipped'},{status:'scheduled'}]});
});
