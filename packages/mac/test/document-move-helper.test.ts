vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Helper} from '../src/helper.js';
const target={bundleId:'com.apple.TextEdit',pid:42,processStartedAt:100,windowId:9};
const receipt={...target,status:'saved',method:'semantic-document-move',atomicExternalCAS:false,documentPath:'/tmp/fixture.txt',backupPath:'/tmp/fixture.txt.vunemi-before-move-test.txt',beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),backupHash:'a'.repeat(64),diskHash:'b'.repeat(64),operationId:'95da94c6-2538-44ea-aa41-8e1d599ed875',foregroundChanged:false,cursorChanged:false,textLength:20,sourceRange:{location:1,length:2},destinationOffset:10};
it.each(['valid','foreign-pid','foreign-window','foreign-incarnation','malformed','unknown'] as const)('journals only a typed bound document receipt as known: %s',async mode=>{
 const dir=mkdtempSync(join(tmpdir(),'document-helper-')),path=join(dir,'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});
 const patch=mode==='foreign-pid'?{pid:43}:mode==='foreign-window'?{windowId:10}:mode==='foreign-incarnation'?{processStartedAt:101}:mode==='malformed'?{backupHash:'forged'}:mode==='unknown'?{status:'unknown',deliveryUnknown:true}:{};
 const transport=vi.spyOn(h as unknown as {transport:()=>Promise<unknown>},'transport').mockResolvedValue({...receipt,...patch});
 try{const result=await h.call('background_document_move',{app:'42',handle:'opaque',destinationOffset:10,backupPath:receipt.backupPath},{ownerRunId:'run-one',target}) as Record<string,unknown>;
 const rows=JSON.parse(readFileSync(path,'utf8')).records;expect(rows).toHaveLength(1);expect(rows[0].state).toBe(mode==='valid'?'native-result':'unknown');expect(rows[0].target).toEqual(target);expect(result.dispatchId).toBe(rows[0].dispatchId);
 await h.releaseRun('run-one');transport.mockResolvedValue(receipt);
 if(mode==='valid')await h.call('background_document_move',{app:'42'},{ownerRunId:'run-two',target});else await expect(h.call('background_document_move',{app:'42'},{ownerRunId:'run-two',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});
 expect(transport).toHaveBeenCalledTimes(mode==='valid'?2:1);expect(readFileSync(path,'utf8')).not.toContain('fixture.txt');
 }finally{h.dispose();rmSync(dir,{recursive:true,force:true});}
});
