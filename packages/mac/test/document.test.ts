import {vi} from 'vitest';
vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createDesktopTools,Helper} from '../src/index.js';
import type {ToolContext,DesktopEvidence} from '@vunemi/agent-core';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
it.each(['deferred-intent','normal','alias','resume','changed','reject-save','bad-disk','bad-native','unknown-save'] as const)('opens and saves exact background document safely: %s',async mode=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'vunemi-document-'))),path=join(dir,'fixture.txt');await writeFile(path,'old\n');
 let value='old\n',appends=0,saves=0;const receipts:DesktopEvidence[]=[];
 class Native extends Helper {
  constructor(){super('/external-boundary');}
  override async permissions(){return {accessibility:true,screenRecording:false,calendars:false,reminders:false};}
  override async call(op:string,args:Record<string,unknown>={}){
   const observation=()=>({pid:42,bundleId:'com.apple.TextEdit',processStartedAt:100,windowId:9,windowTitle:'fixture.txt',documentPath:mode==='alias'?path.replace('/private/','/'):path,controlMode:'backgroundStrict',snapshotId:'observed',targets:[{ref:1,label:value,value,role:'AXTextArea',backgroundActions:['set-value']}]});
   if(op==='background_open_document')return {...observation(),foregroundBefore:7,foregroundAfter:7,foregroundChanged:false};
   if(op==='background_set_value'){expect(args.expectedValue).toBe(value);value=String(args.text);appends++;return {...observation(),...(mode==='bad-native'?{documentPath:'/private/tmp/wrong.txt'}:{}),status:'verified',operationId:'append-op',foregroundChanged:false};}
   if(op==='background_save_document'){
    saves++;if(mode==='reject-save')throw Object.assign(Error('Automation denied'),{nativeRejection:true});
    await writeFile(path,mode==='bad-disk'?'other':value);return {...observation(),status:mode==='unknown-save'?'unknown':'saved',detail:'Native save diagnostic -1728',operationId:'save-op',foregroundChanged:false};
   }
   throw Error('Unexpected native operation: '+op);
  }
 }
 const tool=createDesktopTools({helper:new Native()}).find(t=>t.name==='desktop_background_document');
 try{
  expect(tool,'Document lifecycle tool is available').toBeDefined();
  if(mode==='resume'||mode==='changed'){
   value=mode==='changed'?'user edit':'old\nnew';
   receipts.push({version:1,kind:'verified-append',bundleId:'com.apple.TextEdit',processStartedAt:99,windowId:8,windowTitle:'fixture.txt',fieldRef:1,documentPath:path,valueHash:hash('old\nnew'),beforeHash:hash('old\n'),diskBeforeHash:hash('old\n'),appendedText:'new',operationId:'prior-append'} as DesktopEvidence);
  }
  let intentCalled=false,releaseIntent!:()=>void;const intentGate=new Promise<void>(resolve=>{releaseIntent=resolve;});
  const context:ToolContext={recordDesktopAppendIntent:()=>{intentCalled=true;return mode==='deferred-intent'?intentGate:undefined;},signal:new AbortController().signal,userGoal:`TextEdit arka planda ${path} belgesine "new" ekle ve kaydet.`,handoff:async()=>false,offerUndo(){},attach(){},recordDesktopEvidence:e=>receipts.push(e),desktopDocumentState:()=>({receipts:receipts.slice(),uncertain:false})} as ToolContext;
  const result=tool!.run({path,text:'new'},context);
  if(mode==='deferred-intent'){await vi.waitFor(()=>expect(intentCalled).toBe(true));expect(appends).toBe(0);expect(saves).toBe(0);releaseIntent();}
  if(mode==='changed'||mode==='reject-save'||mode==='bad-disk'||mode==='bad-native'||mode==='unknown-save'){
   if(mode==='unknown-save')await expect(result).rejects.toThrow(/Native save diagnostic -1728/);
   else if(mode==='bad-native')await expect(result).rejects.toMatchObject({deliveryUnknown:true});
   else await expect(result).rejects.toThrow();expect(receipts.some(e=>e.kind==='verified-save')).toBe(false);
   expect(appends).toBe(mode==='changed'?0:1);if(mode==='changed')expect(saves).toBe(0);
  }else{
   await result;expect(await readFile(path,'utf8')).toBe('old\nnew');expect(appends).toBe(mode==='resume'?0:1);expect(saves).toBe(1);
   expect(receipts.at(-1)).toMatchObject({kind:'verified-save',documentPath:path,valueHash:hash('old\nnew'),diskHash:hash('old\nnew')});
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('does not open a model-invented path outside the explicit user request',async()=>{
 const helper=new Helper('/not-used'),tool=createDesktopTools({helper}).find(t=>t.name==='desktop_background_document');expect(tool).toBeDefined();
 await expect(tool!.run({path:'/private/tmp/secret.txt',text:'new'},{signal:new AbortController().signal,userGoal:'TextEdit arka planda /private/tmp/allowed.txt belgesine "new" ekle ve kaydet.',handoff:async()=>false,offerUndo(){},attach(){}})).rejects.toThrow(/request|requested|scope/i);
});
it('keeps fresh approval mandatory across TextEdit atomic saves',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'vunemi-document-scope-'))),path=join(dir,'fixture.txt');
 try{
  await writeFile(path,'old');const tool=createDesktopTools({helper:new Helper('/not-used')}).find(t=>t.name==='desktop_background_document')!;
  const first={path,text:'new'};await tool.check!(first);expect(tool.approvalScope).toBeUndefined();expect(tool.allowSessionApproval).toBeUndefined();expect(tool.alwaysAsk).toBe(true);
  await writeFile(join(dir,'saved.txt'),'saved');const {rename}=await import('node:fs/promises');await rename(join(dir,'saved.txt'),path);
  const next={path,text:'next'};await tool.check!(next);expect(tool.approvalScope).toBeUndefined();expect(tool.alwaysAsk).toBe(true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
