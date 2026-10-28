import {spawn} from 'node:child_process';
import {constants,openSync,closeSync,fstatSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {isAbsolute,dirname,basename,join} from 'node:path';
export class JournalAdmissionError extends Error {
 readonly noInputSent=true;readonly deliveryUnknown=false;
 constructor(readonly reasonCode:'journal-busy'|'journal-unavailable'|'stopped',cause?:unknown){super(`Journal admission refused: ${reasonCode}`,{cause});this.name='JournalAdmissionError';}
}
/** Child locks an inherited duplicate; this parent's fd holds admission through async settlement. */
export async function withJournalAdmission<T>(binary:string,journalPath:string,body:(assertCurrent:()=>void)=>Promise<T>|T,signal?:AbortSignal):Promise<T>{
 if(signal?.aborted)throw new JournalAdmissionError('stopped');
 if(!isAbsolute(binary)||!isAbsolute(journalPath))throw new JournalAdmissionError('journal-unavailable');
 let fd:number|undefined,entered=false;
 try{
  const parent=dirname(journalPath);mkdirSync(parent,{recursive:true,mode:0o700});
  const canonical=realpathSync(parent),path=join(canonical,basename(journalPath)+'.lock');
  fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  const identity=fstatSync(fd);
  if(!identity.isFile()||identity.nlink!==1||(identity.mode&0o077)!==0||process.geteuid&&identity.uid!==process.geteuid())throw new JournalAdmissionError('journal-unavailable');
  const held=fd;
  const assertCurrent=()=>{
   const now=lstatSync(path),opened=fstatSync(held);
   if(realpathSync(parent)!==canonical||!now.isFile()||now.isSymbolicLink()||now.dev!==identity.dev||now.ino!==identity.ino||opened.dev!==identity.dev||opened.ino!==identity.ino||now.nlink!==1||(now.mode&0o077)!==0)throw Object.assign(Error('Journal admission identity changed.'),{reasonCode:'journal-unavailable'});
  };
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(binary,['--journal-lock-fd','3'],{stdio:['ignore','pipe','pipe',held],windowsHide:true});
   let output='',errors=0,settled=false;
   const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
   const abort=()=>{child.kill('SIGKILL');finish(new JournalAdmissionError('stopped'));};
   const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new JournalAdmissionError('journal-unavailable'));},3000);
   child.stdout!.on('data',(chunk:Buffer)=>{output+=chunk.toString('utf8');if(output.length>512){child.kill('SIGKILL');finish(new JournalAdmissionError('journal-unavailable'));}});
   child.stderr!.on('data',(chunk:Buffer)=>{errors+=chunk.length;if(errors>512){child.kill('SIGKILL');finish(new JournalAdmissionError('journal-unavailable'));}});
   child.once('error',cause=>finish(new JournalAdmissionError('journal-unavailable',cause)));
   child.once('close',code=>{
    if(signal?.aborted)return finish(new JournalAdmissionError('stopped'));
    try{const reply=JSON.parse(output.trim()) as Record<string,unknown>;
     if(code===75&&reply.protocol===1&&reply.locked===false&&reply.reason==='busy')return finish(new JournalAdmissionError('journal-busy'));
     if(code!==0||Object.keys(reply).sort().join(',')!=='locked,protocol'||reply.protocol!==1||reply.locked!==true)throw Error('Invalid lock acknowledgement.');
     assertCurrent();finish();
    }catch(cause){finish(new JournalAdmissionError('journal-unavailable',cause));}
   });
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  assertCurrent();if(signal?.aborted)throw new JournalAdmissionError('stopped');
  entered=true;return await body(assertCurrent);
 }catch(error){if(!entered&&!(error instanceof JournalAdmissionError))throw new JournalAdmissionError('journal-unavailable',error);throw error;}
 finally{if(fd!==undefined)closeSync(fd);}
}
