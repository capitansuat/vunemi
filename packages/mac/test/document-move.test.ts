import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {Helper} from '../src/helper.js';
import {NoInputSent} from '../src/target-lease.js';import type {SemanticMoveGuard} from '@vunemi/agent-core';
import {createDocumentMoveTools,movedDocumentText,verifiedDocumentMoveResult} from '../src/document-move.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function setup(moveGuard?:SemanticMoveGuard){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'document-move-'))),path=join(dir,'fixture.txt'),before='aa TOKEN bb END';await writeFile(path,before);
 let value=before,effects=0,validations=0;let uncertain=false,replyPatch:Record<string,unknown>={};
 class Native extends Helper{constructor(){super('/test-boundary');}override async call(op:string,args:Record<string,unknown>={}){
  const observed=()=>({version:1,controlMode:'backgroundStrict',handle:'native-handle',pid:42,bundleId:'com.apple.TextEdit',processStartedAt:100,windowId:9,windowTitle:'fixture.txt',documentPath:path,beforeText:value,beforeHash:hash(value),diskHash:hash(before),sourceRange:{location:3,length:5},observedAt:Date.now()/1000});
  if(op==='document_move_observe'){if(replyPatch.observeReject)throw Object.assign(Error(String(replyPatch.observeReject)),{nativeRejection:true});return observed();}
  if(op==='validate_document_move'){validations++;if(replyPatch.validateReject)throw Object.assign(Error('PRIVATE_NATIVE_REASON'),{nativeRejection:true});if(value!==before)throw Object.assign(Error('stale'),{noInputSent:true});return {...observed(),sourceRange:{length:5,location:3}};}
  if(op==='background_document_move'){if(replyPatch.noInput)throw new NoInputSent('busy before dispatch','target-busy');effects++;expect(args).not.toHaveProperty('expectedValue');expect(args).not.toHaveProperty('sourceRange');expect(await readFile(String(args.backupPath),'utf8')).toBe(before);value='aa  bb TOKENEND';await writeFile(path,value);return {...observed(),status:uncertain?'unknown':'saved',beforeHash:hash(before),afterHash:hash(value),diskHash:hash(value),operationId:'95da94c6-2538-44ea-aa41-8e1d599ed875',method:'semantic-document-move',atomicExternalCAS:false,backupPath:args.backupPath,backupHash:hash(before),textLength:before.length,sourceRange:{location:3,length:5},destinationOffset:args.destinationOffset,foregroundChanged:false,cursorChanged:false,...replyPatch};}
  throw Error('unexpected '+op);
 }}
 const tools=createDocumentMoveTools(new Native(),async()=>{},moveGuard),ctx={runId:'run-one',signal:new AbortController().signal,userGoal:`TextEdit ${path} belgesinde seçili metni taşı ve kaydet`,assertToolActive(){},handoff:async()=>false,offerUndo(){},attach(){},produced(){}} as any;
 const observe=tools.find(t=>t.name==='desktop_document_move_observe')!,move=tools.find(t=>t.name==='desktop_document_move')!;
 return {dir,path,before,ctx,observe,move,setValue:(v:string)=>value=v,setUnknown:()=>uncertain=true,setReplyPatch:(patch:Record<string,unknown>)=>replyPatch=patch,counts:()=>({effects,validations})};
}
it('observes exact scoped document then approved two-argument move backs up and verifies actual disk',async()=>{const s=await setup();try{
 const observation=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:observation.targetId,destinationOffset:12};
 expect(s.move.alwaysAsk).toBe(true);expect(s.move.allowSessionApproval).not.toBe(true);
 const preview=await s.move.preview!(args);expect(preview).toContain('TOKEN');expect(s.counts().validations).toBe(0);
 await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});
 expect(await s.move.preview!(args)).toBe(preview);
 const result=JSON.parse(await s.move.run(args,s.ctx) as string);expect(result.status).toBe('saved-and-verified');expect(await readFile(s.path,'utf8')).toBe('aa  bb TOKENEND');expect(s.counts().effects).toBe(1);
 const backups=(await readdir(s.dir)).filter(x=>x.includes('before-move'));expect(backups).toHaveLength(1);expect(await readFile(join(s.dir,backups[0]!),'utf8')).toBe(s.before);
 }finally{await rm(s.dir,{recursive:true,force:true});}});
it.each(['stale','mutated-args','wrong-owner','stop','unknown'] as const)('never silently retries or invents scope: %s',async mode=>{const s=await setup();try{
 const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});
 if(mode==='stale')s.setValue('user edit');if(mode==='mutated-args')args.destinationOffset=13;if(mode==='wrong-owner')s.ctx.runId='other';if(mode==='stop'){const c=new AbortController();c.abort();s.ctx.signal=c.signal;}if(mode==='unknown')s.setUnknown();
 await expect(s.move.run(args,s.ctx)).rejects.toThrow();expect(s.counts().effects).toBe(mode==='unknown'?1:0);
 await expect(s.move.run(args,s.ctx)).rejects.toThrow();expect(s.counts().effects).toBe(mode==='unknown'?1:0);
 }finally{await rm(s.dir,{recursive:true,force:true});}});
it('rejects forged source/range or nonexplicit path before native input',async()=>{const s=await setup();try{await expect(s.observe.run({app:'42',path:s.path,windowId:9},{...s.ctx,userGoal:'move other file'})).rejects.toThrow();expect(s.counts().effects).toBe(0);}finally{await rm(s.dir,{recursive:true,force:true});}});
it('preserves an external disk edit made while approval waits without creating a backup or dispatch',async()=>{const s=await setup();try{const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});await writeFile(s.path,'external version');await expect(s.move.run(args,s.ctx)).rejects.toMatchObject({noInputSent:true,deliveryUnknown:false});expect(await readFile(s.path,'utf8')).toBe('external version');expect(await readdir(s.dir)).toEqual(['fixture.txt']);expect(s.counts().effects).toBe(0);}finally{await rm(s.dir,{recursive:true,force:true});}});
it.each([{pid:43},{windowId:10},{backupHash:hash('bad')},{cursorChanged:true}])('rejects a native saved reply that does not certify this exact target: %j',async patch=>{const s=await setup();try{const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});s.setReplyPatch(patch);await expect(s.move.run(args,s.ctx)).rejects.toMatchObject({deliveryUnknown:true});await expect(s.move.run(args,s.ctx)).rejects.toThrow();expect(s.counts().effects).toBe(1);}finally{await rm(s.dir,{recursive:true,force:true});}});
it('uses UTF16 boundaries and cannot certify a saved status without typed target/backup/content evidence',()=>{
 expect(movedDocumentText('A😀BC',{location:1,length:2},5)).toBe('ABC😀');expect(()=>movedDocumentText('A😀BC',{location:1,length:1},5)).toThrow();
 expect(()=>movedDocumentText('aaaa',{location:0,length:1},4)).toThrow();
 expect(verifiedDocumentMoveResult({status:'saved'})).toBe(false);
 const result={status:'saved',method:'semantic-document-move',atomicExternalCAS:false,bundleId:'com.apple.TextEdit',pid:42,processStartedAt:100,windowId:9,documentPath:'/tmp/a.txt',backupPath:'/tmp/a.txt.vunemi-before-move-test.txt',beforeHash:hash('before'),afterHash:hash('after'),diskHash:hash('after'),backupHash:hash('before'),operationId:'95da94c6-2538-44ea-aa41-8e1d599ed875',foregroundChanged:false,cursorChanged:false,textLength:20,sourceRange:{location:1,length:2},destinationOffset:10};
 expect(verifiedDocumentMoveResult(result)).toBe(true);
 for(const patch of [{backupHash:hash('forged')},{diskHash:hash('forged')},{sourceRange:{location:1,length:200}},{destinationOffset:2},{cursorChanged:true},{deliveryUnknown:true},{operationId:'not-an-operation'}])expect(verifiedDocumentMoveResult({...result,...patch})).toBe(false);
});
it.each(['verified','unknown','bad-reply','refused','settlement-error','busy'] as const)('coordinates exact path and settles once after actual proof: %s',async mode=>{
 let path='',begins=0;const settled:string[]=[];
 const guard:SemanticMoveGuard={assertAvailable(paths){expect(paths).toEqual([path]);if(mode==='busy')throw Error('other move owns this path');},begin(owner,paths){expect(owner).toBe('run-one');expect(paths).toEqual([path]);begins++;return 'owned-operation';},settle(id,outcome){expect(id).toBe('owned-operation');settled.push(outcome);if(mode==='settlement-error')throw Error('durable settlement failed');}};
 const s=await setup(guard);path=s.path;try{const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};
  if(mode==='busy'){await expect(s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}})).rejects.toThrow(/owns/);expect(begins).toBe(0);expect(s.counts().effects).toBe(0);return;}
  await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});if(mode==='unknown')s.setUnknown();if(mode==='bad-reply')s.setReplyPatch({backupHash:hash('wrong')});if(mode==='refused')s.setReplyPatch({noInput:true});
  if(mode==='verified')await s.move.run(args,s.ctx);else await expect(s.move.run(args,s.ctx)).rejects.toThrow();
  expect(begins).toBe(1);expect(settled).toEqual([mode==='verified'||mode==='settlement-error'?'verified':mode==='refused'?'refused':'unknown']);
 }finally{await rm(s.dir,{recursive:true,force:true});}
});
it.each([true,false])('uncertain errors expose only validated diagnostic metadata: %s',async valid=>{const s=await setup();try{
 const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});
 s.setReplyPatch({status:'unknown',dispatchId:valid?'95da94c6-2538-44ea-aa41-8e1d599ed875':'PRIVATE/PATH',phase:valid?'save':'PRIVATE_LABEL',reasonCode:valid?'document-move-unverified':'PRIVATE_REASON'});
 const error=await s.move.run(args,s.ctx).catch(e=>e);expect(error.deliveryUnknown).toBe(true);expect(error.message).not.toContain('PRIVATE');if(valid){expect(error.message).toContain('Dispatch ID: 95da94c6-2538-44ea-aa41-8e1d599ed875');expect(error.message).toContain('phase: save');}else expect(error.message).not.toContain('Dispatch ID');
 }finally{await rm(s.dir,{recursive:true,force:true});}});

it.each(['fifo','symlink'] as const)('refuses a nonregular or linked document without native observation: %s',async mode=>{const s=await setup();try{await rm(s.path);if(mode==='fifo')execFileSync('/usr/bin/mkfifo',[s.path]);else {await writeFile(join(s.dir,'other.txt'),'private outside target');await symlink(join(s.dir,'other.txt'),s.path);}await expect(s.observe.run({app:'42',path:s.path,windowId:9},s.ctx)).rejects.toThrow();expect(s.counts()).toEqual({effects:0,validations:0});}finally{await rm(s.dir,{recursive:true,force:true});}},1000);

it('classifies a native readonly preflight rejection as no move input, without leaking native details',async()=>{const s=await setup();try{const o=JSON.parse(await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx) as string),args={targetId:o.targetId,destinationOffset:12};await s.move.check!(args,{runId:s.ctx.runId,signal:s.ctx.signal,assertToolActive(){}});s.setReplyPatch({validateReject:true});const error=await s.move.run(args,s.ctx).catch(e=>e);expect(error).toMatchObject({noInputSent:true,deliveryUnknown:false});expect(error.message).not.toContain('PRIVATE');expect(s.counts().effects).toBe(0);expect(await readdir(s.dir)).toEqual(['fixture.txt']);}finally{await rm(s.dir,{recursive:true,force:true});}});

it.each(['document-move-preflight:permission:-1743','document-move-preflight:path:-1728','PRIVATE_REASON'])('observation refuses capability errors before a handle/card with bounded metadata: %s',async message=>{const s=await setup();try{s.setReplyPatch({observeReject:message});const error=await s.observe.run({app:'42',path:s.path,windowId:9},s.ctx).catch(e=>e);expect(error).toMatchObject({noInputSent:true,deliveryUnknown:false});expect(error.message).not.toContain('PRIVATE');if(message.includes(':permission:')){expect(error).toMatchObject({phase:'permission',numericCode:-1743});expect(error.message).toContain('[permission:-1743]');}if(message.includes(':path:'))expect(error).toMatchObject({phase:'path',numericCode:-1728});expect(s.counts().effects).toBe(0);expect(await readdir(s.dir)).toEqual(['fixture.txt']);}finally{await rm(s.dir,{recursive:true,force:true});}});
