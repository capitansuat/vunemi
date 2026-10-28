import {it} from 'vitest';
import {Helper} from '../src/helper.js';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
it.skipIf(process.env.VUNEMI_DOCUMENT_DIAGNOSTIC!=='1')('reads old synthetic target without replay or opening',async()=>{
 const dir=resolve('../../research/document-save-debug-2026-10-15',new Date().toISOString().replaceAll(':','-'));mkdirSync(dir,{recursive:true});
 const helper=new Helper('/Applications/Vunemi.app/Contents/Resources/VunemiHelper');const out:Record<string,unknown>={at:new Date().toISOString(),readOnly:true};
 try{const record=JSON.parse(readFileSync(join(homedir(),'Library/Application Support/Vunemi/background-operations.json'),'utf8')).records.find((r:{dispatchId:string})=>r.dispatchId==='37f42b3d-a0f1-4e3a-8736-c746053b520c');out.record=record;out.apps=await helper.apps();out.windows=await helper.call('windows',{app:'com.apple.TextEdit'});if(record?.target)try{out.observation=await helper.call('describe',{app:String(record.target.pid),part:'window',windowId:record.target.windowId,background:true});}catch(error){out.observationError=String(error);}}finally{writeFileSync(join(dir,'old-target-readonly.json'),JSON.stringify(out,null,2));helper.dispose();}
},30000);
