import {afterAll,beforeAll,expect,it} from 'vitest';
import {fork,type ChildProcess,execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const binary=resolve('../../native/VunemiHelper/.build/release/VunemiHelper');
const enabled=process.platform==='darwin'&&existsSync(binary);
const temporary:string[]=[],children:ChildProcess[]=[];let script:string;
beforeAll(()=>{if(!enabled)return;const dir=realpathSync(mkdtempSync(join(tmpdir(),'safe-move-process-bundle-')));temporary.push(dir);script=join(dir,'fixture.cjs');execFileSync(resolve('../mac/node_modules/.bin/esbuild'),[resolve('test/fixtures/safe-move-process.ts'),'--bundle','--platform=node','--format=cjs',`--outfile=${script}`],{stdio:'pipe'});});
afterAll(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');for(const dir of temporary)rmSync(dir,{recursive:true,force:true});});
function fixture(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'safe-move-process-')));temporary.push(dir);mkdirSync(join(dir,'to'));for(const name of ['first','second','recovery'])writeFileSync(join(dir,`${name}.txt`),`Synthetic ${name}`);return dir;}
function writer(dir:string,mode:string,name='first'){
 const child=fork(script,[binary,dir,mode,name],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);
 const messages:any[]=[];let stderr='';child.stderr?.on('data',b=>stderr+=String(b));child.on('message',m=>messages.push(m));
 const wait=(event:string)=>new Promise<any>((accept,reject)=>{const start=Date.now();const timer=setInterval(()=>{const found=messages.find(m=>m.event===event||m.event==='fatal');if(found){clearInterval(timer);found.event==='fatal'?reject(Error(found.message)):accept(found);}else if(Date.now()-start>10000||child.exitCode!==null){clearInterval(timer);reject(Error(`Missing ${event}; exit=${child.exitCode}; ${stderr}`));}},10);});
 return{child,wait};
}
const rows=(dir:string)=>JSON.parse(readFileSync(join(dir,'journal.json'),'utf8')).rows;
it.skipIf(!enabled)('native admission excludes another process throughout async effect; constructor stays read-only',async()=>{
 const dir=fixture(),first=writer(dir,'hold');await first.wait('effect');const before=readFileSync(join(dir,'journal.json'),'utf8');
 const observer=await writer(dir,'observe').wait('done');expect(observer.unchanged).toBe(true);expect(observer.rows[0].state).toBe('dispatched');
 const contender=await writer(dir,'move','second').wait('done');expect(contender).toMatchObject({effects:0,backups:0});expect(contender.reason).toBe('journal-unavailable');expect(readFileSync(join(dir,'journal.json'),'utf8')).toBe(before);
 first.child.send('release');expect(await first.wait('done')).toMatchObject({status:'verified',effects:1,backups:1});
},20000);
it.skipIf(!enabled)('a later process reloads and merges the first verified operation',async()=>{
 const dir=fixture();expect(await writer(dir,'move').wait('done')).toMatchObject({status:'verified'});const old=rows(dir)[0];
 expect(await writer(dir,'move','second').wait('done')).toMatchObject({status:'verified',effects:1,backups:1});
 const result=rows(dir);expect(result).toHaveLength(2);expect(result[0]).toEqual(old);expect(result.map((r:any)=>r.state)).toEqual(['verified','verified']);
},20000);
it.skipIf(!enabled)('killing dispatched writer releases native lease; next writer quarantines unknown without replay',async()=>{
 const dir=fixture(),first=writer(dir,'hold');await first.wait('effect');const operation=rows(dir)[0].operationId;
 await new Promise<void>(resolve=>{first.child.once('exit',()=>resolve());first.child.kill('SIGKILL');});
 const recovery=await writer(dir,'recover','recovery').wait('done');expect(recovery).toMatchObject({reason:'synthetic-refusal',effects:1,backups:1,blocked:true});
 expect(recovery.rows.find((r:any)=>r.operationId===operation).state).toBe('unknown');expect(existsSync(join(dir,'first.txt'))).toBe(true);expect(existsSync(join(dir,'to','first.txt'))).toBe(false);
 expect(rows(dir).map((r:any)=>r.state)).toEqual(['unknown','refused']);
},20000);
