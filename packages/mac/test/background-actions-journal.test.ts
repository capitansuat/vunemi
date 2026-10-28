vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Helper} from '../src/helper.js';
const target={bundleId:'org.scope.fixture',pid:123,processStartedAt:100,windowId:9};
it.each(['background_scroll_position','background_menu_open','background_menu_select'])('journals %s durably and keeps unknown target blocked after restart',async op=>{const path=join(mkdtempSync(join(tmpdir(),'extended-journal-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});const transport=vi.spyOn(h as unknown as {transport:()=>Promise<unknown>},'transport').mockRejectedValue(Error('lost after dispatch'));await expect(h.call(op,{app:'123'},{ownerRunId:'owner',target})).rejects.toMatchObject({deliveryUnknown:true,noInputSent:false});const record=JSON.parse(readFileSync(path,'utf8')).records[0];expect(record).toMatchObject({op,state:'unknown',target});const restarted=new Helper(process.execPath,{operationJournalPath:path}),again=vi.spyOn(restarted as unknown as {transport:()=>Promise<unknown>},'transport');await expect(restarted.call(op,{app:'123'},{ownerRunId:'other',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});expect(again).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(1);});
