import {execFile} from 'node:child_process';
import type {ToolDef} from '@vunemi/agent-core';
type Run=(path:string,args:string[],opts:{signal:AbortSignal;timeout:number;maxBuffer:number})=>Promise<{stdout:string;stderr:string}>;
const execute:Run=(path,args,opts)=>new Promise((resolve,reject)=>{
 execFile(path,args,{...opts,encoding:'utf8'},(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
});
/** A fixed OS read, deliberately separate from driving Settings or a terminal. */
export function softwareUpdatesTool(run:Run=execute):ToolDef<Record<string,unknown>> {
 return {
  name:'desktop_software_updates',
  description:'Read available macOS updates. Never installs or downloads.',
  parameters:{type:'object',properties:{},additionalProperties:false},
  actionClass:'read',untrustedOutput:true,
  preview:async()=> 'Check available macOS updates',
  async run(args,ctx){
   if(Object.keys(args).length)throw Error('This read-only check accepts no arguments.');
   if(ctx.signal.aborted)throw Error('Stopped before checking updates.');
   ctx.assertToolActive?.();
   const result=await run('/usr/sbin/softwareupdate',['--list'],{signal:ctx.signal,timeout:120000,maxBuffer:262144});
   if(ctx.signal.aborted)throw Error('Stopped while checking updates.');
   ctx.assertToolActive?.();
   const output=result.stdout.trim();
   if(!output)throw Error('Software Update returned no status. Update availability is unverified.');
   return `macOS Software Update — read-only check completed. No download or installation was requested.\n${output}`;
  }
 };
}
