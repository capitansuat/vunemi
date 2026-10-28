import {vi} from 'vitest';
vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Helper} from '../src/helper.js';
it('cooperatively stops drag and awaits same-target release/child exit before settling owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'drag-cancel-')),binary=join(dir,'helper'),events=join(dir,'events'),path=join(dir,'journal.json');
 writeFileSync(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');const file=${JSON.stringify(events)};let moving,requestId;process.on('SIGUSR1',()=>{clearInterval(moving);fs.appendFileSync(file,'up:123:9\\n');process.stdout.write(JSON.stringify({id:requestId,ok:true,result:{status:'verified'}})+'\\n');setTimeout(()=>{fs.appendFileSync(file,'exited\\n');process.exit(0)},100)});process.on('SIGTERM',()=>{fs.appendFileSync(file,'forced\\n');process.exit(2)});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);requestId=req.id;fs.writeFileSync(file,'down:123:9\\n');moving=setInterval(()=>fs.appendFileSync(file,'move:123:9\\n'),20);});\n`);chmodSync(binary,0o755);
 const h=new Helper(binary,{operationJournalPath:path}),stop=new AbortController(),target={bundleId:'org.scope.sliderfixture',pid:123,processStartedAt:100,windowId:9};
 const pending=h.call('background_drag',{app:'123'},{ownerRunId:'drag-owner',target,signal:stop.signal});const rejected=expect(pending).rejects.toMatchObject({deliveryUnknown:true,noInputSent:false});
 for(let n=0;n<200&&!existsSync(events);n++)await new Promise(r=>setTimeout(r,5));expect(existsSync(events)).toBe(true);stop.abort(Error('Stopped'));let settled=false;const release=h.releaseRun('drag-owner').then(()=>{settled=true;});await new Promise(r=>setTimeout(r,25));expect(settled).toBe(false);await rejected;await release;
 const lines=readFileSync(events,'utf8').trim().split('\n');expect(lines.filter(s=>s==='down:123:9')).toHaveLength(1);expect(lines.filter(s=>s==='up:123:9')).toHaveLength(1);expect(lines).not.toContain('forced');expect(lines.slice(lines.indexOf('up:123:9')+1)).toEqual(['exited']);expect(JSON.parse(readFileSync(path,'utf8')).records[0].state).toBe('unknown');h.dispose();
});
