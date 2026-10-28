import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeRecipeDriver} from '../src/native-recipe.js';
it('rejects invalid literal before native prepare or backup',async()=>{
 let calls=0;const driver=new NativeRecipeDriver({helper:{call:async()=>{calls++;throw Error('unexpected')}} as any,assertPath:p=>p,helperRevision:()=> 'a'.repeat(64)});
 await expect(driver.prepare({path:'/does-not-exist.txt',pid:2,windowId:3},'x'.repeat(257),{runId:'r',signal:new AbortController().signal,assertActive(){},beforeChild(){},recordBackup(){}})).rejects.toThrow();expect(calls).toBe(0);
});
it('never sends native effect when the current file version differs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vun13p2-')),path=join(dir,'a.txt');await writeFile(path,'fixture');
 let calls=0;const driver=new NativeRecipeDriver({helper:{call:async()=>{calls++;throw Error('unexpected')}} as any,assertPath:p=>p,helperRevision:()=> 'a'.repeat(64)});
 const binding:any={target:{path,pid:2,windowId:3,bundleId:'com.apple.TextEdit',startSec:'1',startUsec:'1',parentDevice:'0',parentInode:'0'},version:{sha256:'b'.repeat(64)},textUnits:7,uid:1,securitySessionId:1,helperRevision:'a'.repeat(64)};
 const out=await driver.execute(binding,'!',join(dir,'backup'),{runId:'r',signal:new AbortController().signal,assertActive(){},beforeChild(){},recordBackup(){}});
 expect(out.status).toBe('no-input');expect(calls).toBe(0);expect(await readFile(path,'utf8')).toBe('fixture');
});
import {lstat,realpath} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
async function nativeFixture(abortAfterAppend=false){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'vun13p2-'))),path=join(dir,'a.txt');await writeFile(path,'fixture');
 async function current(){const s=await lstat(path,{bigint:true}),parent=await lstat(dir,{bigint:true});return{target:{path,pid:12345,windowId:67,bundleId:'com.apple.TextEdit' as const,startSec:'1',startUsec:'1',parentDevice:String(parent.dev),parentInode:String(parent.ino)},version:{device:String(s.dev),inode:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),sha256:sha(await readFile(path,'utf8'))},textUnits:(await readFile(path,'utf8')).length,uid:1,securitySessionId:1,helperRevision:'a'.repeat(64)};}
 const binding=await current(),calls:string[]=[],abort=new AbortController(),child:string[]=[];const backupPath=path+'.vunemi-before-scheduled-test';
 const helper={call:async(op:string,args:any,opts:any)=>{calls.push(op);if(op==='scheduled_recipe_prepare')return{binding,handle:'append'};if(op==='scheduled_recipe_backup'){try{await writeFile(backupPath,'fixture',{flag:'wx'});return{status:'backup-created',backupCreated:true,path:backupPath,sha256:sha('fixture')};}catch{return{status:'no-input',noInputSent:true};}}if(op==='scheduled_document_append'){opts.beforeDispatch(randomUUID());if(abortAfterAppend)abort.abort();return{status:'verified',operationId:randomUUID(),saveHandle:'save',afterHash:sha('fixture!')};}if(op==='scheduled_document_save'){opts.beforeDispatch(randomUUID());await writeFile(path,'fixture!');return{status:'verified',operationId:randomUUID(),binding:await current(),evidence:{version:1,kind:'verified-save',bundleId:'com.apple.TextEdit',processStartedAt:1,windowId:67,windowTitle:'a.txt',fieldRef:1,documentPath:path,valueHash:sha('fixture!'),diskHash:sha('fixture!'),operationId:randomUUID()}};}throw Error('Unexpected opcode');}};
 const driver=new NativeRecipeDriver({helper:helper as any,assertPath:p=>p,helperRevision:()=> 'a'.repeat(64)}),context={runId:'native-r',signal:abort.signal,assertActive(){if(abort.signal.aborted)throw Error('stopped');},beforeChild:(phase:string,id:string)=>child.push(phase+':'+id),recordBackup:(p:string,h:string)=>{expect(p).toBe(backupPath);expect(h).toBe(sha('fixture'));}};
 return{driver,context,binding,path,backupPath,calls,child};
}
it('backs up once, appends once, saves once and independently reads actual bytes',async()=>{const f=await nativeFixture();const r=await f.driver.execute(f.binding,'!',f.backupPath,f.context);expect(r.status).toBe('verified');expect(await readFile(f.path,'utf8')).toBe('fixture!');expect(await readFile(f.backupPath,'utf8')).toBe('fixture');expect(f.calls).toEqual(['scheduled_recipe_prepare','scheduled_recipe_backup','scheduled_document_append','scheduled_document_save']);expect(f.child).toHaveLength(2);});
it('does not send save after append cancellation and preserves backup/unknown',async()=>{const f=await nativeFixture(true);const r=await f.driver.execute(f.binding,'!',f.backupPath,f.context);expect(r.status).toBe('unknown');expect(f.calls).not.toContain('scheduled_document_save');expect(await readFile(f.backupPath,'utf8')).toBe('fixture');expect(f.child).toHaveLength(1);});
it('backup collision never overwrites or sends native input',async()=>{const f=await nativeFixture();await writeFile(f.backupPath,'do not replace');const r=await f.driver.execute(f.binding,'!',f.backupPath,f.context);expect(r.status).toBe('no-input');expect(f.calls).toEqual(['scheduled_recipe_prepare','scheduled_recipe_backup']);expect(f.child).toHaveLength(0);expect(await readFile(f.backupPath,'utf8')).toBe('do not replace');});
