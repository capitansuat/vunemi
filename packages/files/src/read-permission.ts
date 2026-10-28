import {lstatSync,realpathSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {basename,dirname,extname,resolve} from 'node:path';
import {homedir} from 'node:os';
import type {ToolDef,TaskPermissionDescriptor} from '@vunemi/agent-core';
import type {Roots} from './roots.js';
const readers=new WeakMap<object,(limit:number)=>Buffer>();
export function readPreparedFile(args:object,limit:number):Buffer|undefined{return readers.get(args)?.(limit);}
const guards=new WeakMap<object,()=>void>();
export function assertPreparedFileRead(args:object):void{guards.get(args)?.();}
/** Plain text only: structured formats and image attachment have separate lifetimes. */
export function createFileReadPermission(roots:Roots):NonNullable<ToolDef<{path:string}>['taskPermission']>{
 const prepared=new WeakMap<object,{path:string;descriptor:TaskPermissionDescriptor;parents:string}>();
 function metadata(args:{path:string}){
  const path=roots.resolve(args.path,'read');
  const input=resolve(args.path.startsWith('~/')?homedir()+args.path.slice(1):args.path);
  if(realpathSync(input)!==input||input!==path)throw new Error('Scoped reads require an exact canonical file path.');
  if(!/\.(?:txt|md|csv|json|log|yaml|yml|xml|html|css|js|ts|tsx|jsx|py|sql)$/i.test(extname(path)))return null;
  const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())return null;
  const parents=[];let p=dirname(path);for(;;){const s=lstatSync(p,{bigint:true});if(s.isSymbolicLink())throw new Error('Symlink parent.');parents.push([p,String(s.dev),String(s.ino)]);const next=dirname(p);if(next===p)break;p=next;}
  const descriptor:TaskPermissionDescriptor={effect:'file-read',target:{kind:'file',path,name:basename(path)},identity:{kind:'file',path,device:String(stat.dev),inode:String(stat.ino),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)}};
  return {path:args.path,descriptor,parents:JSON.stringify(parents)};
 }
 return {async prepare(args,ctx){ctx.assertToolActive();try{const value=metadata(args);if(!value)return null;prepared.set(args,value);guards.set(args,()=>{const current=metadata(args);if(!current||JSON.stringify(current)!==JSON.stringify(value))throw new Error("Read target version changed.");});readers.set(args,(limit)=>{
    guards.get(args)!();
    const identity=value.descriptor.identity;if(identity.kind!=='file')throw new Error('Invalid prepared file.');
    const fd=openSync(identity.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const same=()=>{const stat=fstatSync(fd,{bigint:true});return stat.isFile()&&String(stat.dev)===identity.device&&String(stat.ino)===identity.inode&&String(stat.size)===identity.size&&String(stat.mtimeNs)===identity.mtimeNs&&String(stat.ctimeNs)===identity.ctimeNs;};
    try{if(!same())throw new Error('Opened file differs from approved version.');guards.get(args)!();const buffer=Buffer.alloc(Math.max(0,Math.min(limit,Number(identity.size))));const count=readSync(fd,buffer,0,buffer.length,0);if(!same())throw new Error('File changed during read.');guards.get(args)!();return buffer.subarray(0,count);}finally{closeSync(fd);}
   });return structuredClone(value.descriptor);}catch{return null;}},async revalidate(args,descriptor,ctx){ctx.assertToolActive();try{const old=prepared.get(args);const fresh=metadata(args);return !!old&&!!fresh&&JSON.stringify(old)===JSON.stringify(fresh)&&JSON.stringify(descriptor)===JSON.stringify(old.descriptor);}catch{return false;}}};
}
