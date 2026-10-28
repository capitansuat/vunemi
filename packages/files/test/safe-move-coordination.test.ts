import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Roots} from '../src/roots.js';
import {SafeMoveController,type AtomicMoveAdapter,type SafeMovePlan} from '../src/safe-move.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
type Admission=<T>(body:(assertCurrent:()=>void)=>Promise<T>|T,signal?:AbortSignal)=>Promise<T>;
function admission():Admission{let held=false;return async(body,signal)=>{if(held||signal?.aborted)throw Error('Unavailable test admission');held=true;try{return await body(()=>{if(!held)throw Error('Lost test admission');});}finally{held=false;}};}
function fixture(withAdmission:Admission|undefined=admission(),adapter?:AtomicMoveAdapter){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'safe-move-coordination-')));dirs.push(dir);mkdirSync(join(dir,'to'));const source=join(dir,'source.txt'),destination=join(dir,'to','moved.txt'),journalPath=join(dir,'journal.json');writeFileSync(source,'Synthetic original');
 const move=vi.fn(async(request:any)=>{linkSync(request.source,request.destination);unlinkSync(request.source);return{status:'moved' as const};});
 const options={roots:new Roots([dir]),journalPath,adapter:adapter??{move},withAdmission};const c=new SafeMoveController(options);
 return{dir,source,destination,journalPath,options,c,move,prepare:()=>c.prepare({source,destination,ownerId:'owner'})};
}
function row(p:SafeMovePlan,state='unknown',operationId=randomUUID()){return{operationId,ownerId:'old-owner',source:p.source,destination:p.destination,sourceDevice:p.sourceIdentity.device,sourceInode:p.sourceIdentity.inode,state,updatedAt:1};}
it('constructor and prepare never create or rewrite a journal outside admission',()=>{
 const f=fixture(),p=f.prepare();expect(existsSync(f.journalPath)).toBe(false);const seeded={version:1,rows:[row(p,'prepared')]};writeFileSync(f.journalPath,JSON.stringify(seeded));const before=readFileSync(f.journalPath,'utf8');const observer=new SafeMoveController(f.options);expect(readFileSync(f.journalPath,'utf8')).toBe(before);expect(observer.query(seeded.rows[0]!.operationId)?.state).toBe('prepared');
});
it('fails closed with no admission provider and sends no effect',async()=>{
 const f=fixture(undefined);delete (f.options as any).withAdmission;const controller=new SafeMoveController(f.options),p=controller.prepare({source:f.source,destination:f.destination,ownerId:'owner'});
 await expect(controller.run(p,{ownerId:'owner'})).rejects.toMatchObject({noInputSent:true,reasonCode:'journal-unavailable'});expect(f.move).not.toHaveBeenCalled();expect(existsSync(f.journalPath)).toBe(false);
});
it('queries fresh disk and blocks a plan prepared before another writer recorded unknown',async()=>{
 const f=fixture(),p=f.prepare(),old=row(p);writeFileSync(f.journalPath,JSON.stringify({version:1,rows:[old]}));expect(f.c.query(old.operationId)?.state).toBe('unknown');
 await expect(f.c.run(p,{ownerId:'owner'})).rejects.toMatchObject({noInputSent:true,reasonCode:'unknown-operation-blocks-target'});expect(f.move).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(f.journalPath,'utf8')).rows).toEqual([old]);
});
it('quarantines abandoned intent only under admission and never adopts it as success',async()=>{
 let admitted=false;const locked:Admission=async body=>{admitted=true;try{return await body(()=>{if(!admitted)throw Error('lost');});}finally{admitted=false;}};
 const f=fixture(locked),p=f.prepare(),old=row(p,'dispatched');writeFileSync(f.journalPath,JSON.stringify({version:1,rows:[old]}));
 await expect(f.c.run(p,{ownerId:'owner'})).rejects.toMatchObject({noInputSent:true,reasonCode:'unknown-operation-blocks-target'});expect(f.c.query(old.operationId)?.state).toBe('unknown');expect(f.move).not.toHaveBeenCalled();expect(admitted).toBe(false);
});
it('holds admission throughout an awaited effect and refuses another controller without transport',async()=>{
 let finish!:(value:any)=>void;const move=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;})),f=fixture(admission(),{move}),p=f.prepare(),other=new SafeMoveController(f.options),otherSource=join(f.dir,'other.txt'),otherDestination=join(f.dir,'to','other.txt');writeFileSync(otherSource,'Other synthetic');const q=other.prepare({source:otherSource,destination:otherDestination,ownerId:'second'});
 const first=f.c.run(p,{ownerId:'owner'});await vi.waitFor(()=>expect(move).toHaveBeenCalledOnce());
 expect(new SafeMoveController(f.options).query(p.operationId)?.state).toBe('dispatched');
 const blockedSetup=vi.fn();await expect(other.run(q,{ownerId:'second',beforeEffect:blockedSetup})).rejects.toMatchObject({noInputSent:true,reasonCode:'journal-unavailable'});expect(move).toHaveBeenCalledOnce();expect(blockedSetup).not.toHaveBeenCalled();
 finish({status:'not-moved',reasonCode:'synthetic-refusal'});await expect(first).rejects.toMatchObject({noInputSent:true,reasonCode:'synthetic-refusal'});
});
it('losing the writer lease before dispatch cannot write intent or call adapter',async()=>{
 const lost:Admission=async body=>body(()=>{throw Error('Lost writer lease');});const f=fixture(lost),p=f.prepare();await expect(f.c.run(p,{ownerId:'owner'})).rejects.toMatchObject({noInputSent:true,reasonCode:'journal-unavailable'});expect(f.move).not.toHaveBeenCalled();expect(existsSync(f.journalPath)).toBe(false);
});

it('lease loss after transport preserves dispatched intent without certifying success',async()=>{
 let current=true;const lease:Admission=async body=>body(()=>{if(!current)throw Error('Lost lease');});
 const f=fixture(lease,{move:async()=>{current=false;return {status:'moved'};}}),p=f.prepare();
 await expect(f.c.run(p,{ownerId:'owner'})).rejects.toMatchObject({noInputSent:false,deliveryUnknown:true});
 expect(f.c.query(p.operationId)?.state).toBe('dispatched');
});

it('trusted setup cannot run without admission or past a fresh unknown conflict',async()=>{
 const missing=fixture(),beforeEffect=vi.fn();delete (missing.options as any).withAdmission;
 const c=new SafeMoveController(missing.options),q=c.prepare({source:missing.source,destination:missing.destination,ownerId:'owner'});
 await expect(c.run(q,{ownerId:'owner',beforeEffect})).rejects.toMatchObject({reasonCode:'journal-unavailable'});
 const f=fixture(),r=f.prepare();writeFileSync(f.journalPath,JSON.stringify({version:1,rows:[row(r)]}));
 await expect(f.c.run(r,{ownerId:'owner',beforeEffect})).rejects.toMatchObject({reasonCode:'unknown-operation-blocks-target'});
 expect(beforeEffect).not.toHaveBeenCalled();expect(missing.move).not.toHaveBeenCalled();expect(f.move).not.toHaveBeenCalled();
});
it('trusted setup runs inside admission and failed setup prevents dispatch',async()=>{
 let held=false;const lease:Admission=async body=>{held=true;try{return await body(()=>{if(!held)throw Error('lost');});}finally{held=false;}};
 const f=fixture(lease),p=f.prepare(),beforeEffect=vi.fn(()=>{expect(held).toBe(true);throw Error('synthetic backup failed');});
 await expect(f.c.run(p,{ownerId:'owner',beforeEffect})).rejects.toMatchObject({noInputSent:true});
 expect(beforeEffect).toHaveBeenCalledOnce();expect(f.move).not.toHaveBeenCalled();expect(f.c.query(p.operationId)?.state).toBe('refused');
});
