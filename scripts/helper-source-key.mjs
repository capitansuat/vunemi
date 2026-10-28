import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Include every local Swift/C target and header, independent of build output. */
export function helperSourceKey(root,entitlements,identity,distribution){
 const hash=createHash('sha256');
 const add=(name,bytes)=>{hash.update(name+'\0'+bytes.length+'\0');hash.update(bytes);};
 add('Package.swift',readFileSync(join(root,'Package.swift')));
 const walk=relative=>{for(const entry of readdirSync(join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const name=relative+'/'+entry.name;if(entry.isDirectory())walk(name);else if(entry.isFile())add(name,readFileSync(join(root,name)));else throw Error('Unsupported helper source entry: '+name);}};
 walk('Sources');add('entitlements',readFileSync(entitlements));add('signing',Buffer.from(JSON.stringify([identity,distribution,'paths-mapped-v2'])));
 return hash.digest('hex').slice(0,16);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);if(args.length!==4)throw Error('Expected helper root, entitlements, identity and distribution.');
 process.stdout.write(helperSourceKey(...args)+'\n');
}
