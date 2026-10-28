import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {withJournalAdmission} from '../src/journal-coordinator.js';
const binary=process.env.VUNEMI_LOCK_HELPER??resolve('../../native/VunemiHelper/.build/release/VunemiHelper');
const folders:string[]=[];afterEach(()=>{for(const p of folders.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'vun18-admission-'));folders.push(dir);return join(dir,'synthetic.json');}
it.skipIf(!existsSync(binary))('inherited parent fd retains the OS lock after native child exits, through async settlement',async()=>{
 const path=fixture();let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const first=withJournalAdmission(binary,path,async assert=>{assert();ready();await gate;assert();return 'first';});
 await started;let secondEffects=0;
 await expect(withJournalAdmission(binary,path,()=>{secondEffects++;})).rejects.toMatchObject({reasonCode:'journal-busy',noInputSent:true});
 expect(secondEffects).toBe(0);release();expect(await first).toBe('first');expect(await withJournalAdmission(binary,path,()=> 'next')).toBe('next');
});
it.skipIf(!existsSync(binary))('abort before acquisition never invokes a callback',async()=>{const c=new AbortController();c.abort();let effects=0;await expect(withJournalAdmission(binary,fixture(),()=>effects++,c.signal)).rejects.toMatchObject({reasonCode:'stopped',noInputSent:true});expect(effects).toBe(0);});
it.skipIf(!existsSync(binary))('refuses symlink lock files without changing their target',async()=>{const path=fixture(),target=path+'.target';writeFileSync(target,'unchanged');symlinkSync(target,path+'.lock');let effects=0;await expect(withJournalAdmission(binary,path,()=>effects++)).rejects.toMatchObject({reasonCode:'journal-unavailable',noInputSent:true});expect(effects).toBe(0);expect(readFileSync(target,'utf8')).toBe('unchanged');});
it.skipIf(!existsSync(binary))('the headless native mode rejects missing inherited fd without desktop access',()=>{try{execFileSync(binary,['--journal-lock-fd','3'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});throw Error('Expected invalid-fd refusal');}catch(e:any){expect(e.status).toBe(64);expect(JSON.parse(e.stdout)).toMatchObject({protocol:1,locked:false,reason:'invalid-fd'});}});
it.skipIf(!existsSync(binary))('a replaced lock identity is rejected before a journal write',async()=>{const path=fixture();await withJournalAdmission(binary,path,assert=>{rmSync(path+'.lock');writeFileSync(path+'.lock','replacement',{mode:0o600});expect(assert).toThrow('identity changed');});});

function fake(path:string,code:string){const script=path+'.helper';writeFileSync(script,'#!/usr/bin/env node\n'+code,{mode:0o700});return script;}
it.skipIf(!existsSync(binary))('spawn errors and malformed acknowledgements send no effect and release descriptors',async()=>{
 for(const make of [(p:string)=>p+'.missing',(p:string)=>fake(p,"process.stdout.write('{}\\n')")]){const path=fixture();let effects=0;await expect(withJournalAdmission(make(path),path,()=>effects++)).rejects.toMatchObject({noInputSent:true,reasonCode:'journal-unavailable'});expect(effects).toBe(0);expect(await withJournalAdmission(binary,path,()=>true)).toBe(true);}
});
it.skipIf(!existsSync(binary))('abort during acquisition refuses the callback and releases the descriptor',async()=>{
 const path=fixture(),helper=fake(path,'setInterval(()=>{},1000);'),c=new AbortController();let effects=0;
 const pending=withJournalAdmission(helper,path,()=>effects++,c.signal);c.abort();await expect(pending).rejects.toMatchObject({reasonCode:'stopped',noInputSent:true});expect(effects).toBe(0);expect(await withJournalAdmission(binary,path,()=>true)).toBe(true);
});
it.skipIf(!existsSync(binary))('a callback exception remains its own error and releases the lock',async()=>{const path=fixture(),error=Error('Synthetic callback failure');await expect(withJournalAdmission(binary,path,()=>{throw error;})).rejects.toBe(error);expect(await withJournalAdmission(binary,path,()=>true)).toBe(true);});
it.skipIf(!existsSync(binary))('a nonresponding admission child times out without invoking the effect',async()=>{const path=fixture(),helper=fake(path,'setInterval(()=>{},1000);');let effects=0;await expect(withJournalAdmission(helper,path,()=>effects++)).rejects.toMatchObject({reasonCode:'journal-unavailable',noInputSent:true});expect(effects).toBe(0);expect(await withJournalAdmission(binary,path,()=>true)).toBe(true);});
