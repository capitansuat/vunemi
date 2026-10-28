vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
import {expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Helper,type MacApp} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import type {ToolContext} from '@vunemi/agent-core';
const target={bundleId:'com.apple.calculator',pid:42,processStartedAt:123,windowId:9};
const ctx:ToolContext={runId:'cursor-test',signal:new AbortController().signal,handoff:async()=>false,offerUndo(){},attach(){}};
it.each(['background_press','background_menu_open','background_set_value','background_save_document'])('keeps inconsistent %s success with cursor change durably unknown after settlement',async op=>{
 const path=join(mkdtempSync(join(tmpdir(),'cursor-unknown-')),'journal.json'),h=new Helper(process.execPath,{operationJournalPath:path});
 const transport=vi.spyOn(h as unknown as {transport:()=>Promise<unknown>},'transport').mockResolvedValue({status:op==='background_save_document'?'saved':'delivered',foregroundChanged:false,cursorChanged:true});
 const result=await h.call(op,{app:'42'},{ownerRunId:'a',target}) as {dispatchId:string;deliveryUnknown:boolean};
 expect(result.deliveryUnknown).toBe(true);expect(h.queryOperation(result.dispatchId)?.state).toBe('unknown');
 await h.releaseRun('a');await expect(h.call(op,{app:'42'},{ownerRunId:'b',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});expect(transport).toHaveBeenCalledTimes(1);
 const restart=new Helper(process.execPath,{operationJournalPath:path}),next=vi.spyOn(restart as unknown as {transport:()=>Promise<unknown>},'transport');
 await expect(restart.call(op,{app:'42'},{ownerRunId:'c',target})).rejects.toMatchObject({reasonCode:'delivery-blocked',noInputSent:true});expect(next).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(path,'utf8')).records[0].state).toBe('unknown');
});
class Bridge extends Helper{
 calls:string[]=[];
 constructor(){super('/unused');}
 override async permissions(){return {accessibility:true,screenRecording:true,calendars:false,reminders:false};}
 override async apps():Promise<MacApp[]>{return [{...target,name:'Calculator',frontmost:false}];}
 override async call(op:string){this.calls.push(op);if(op==='validate_background')return {...target,controlMode:'backgroundStrict'};if(op==='background_press')return {status:'delivered',foregroundChanged:false,cursorChanged:true};throw Error('unexpected');}
}
it('legacy background press refuses an inconsistent delivered reply and cannot report success',async()=>{
 const h=new Bridge(),tool=createDesktopTools({helper:h}).find(t=>t.name==='desktop_background_click')!;
 await expect(tool.run({app:'Calculator',snapshotId:'s',ref:1,label:'7'},ctx)).rejects.toMatchObject({deliveryUnknown:true});
 expect(h.calls).toEqual(['validate_background','background_press']);
});
it.each(['Codex','com.openai.codex','99'])('Codex selector %s cannot reach native observation or mutation',async selector=>{
 const h=new Bridge();h.apps=async()=>[{name:'Codex',bundleId:'com.openai.codex',pid:99,frontmost:false}];
 const tools=createDesktopTools({helper:h});
 await expect(tools.find(t=>t.name==='desktop_background_describe')!.run({app:selector},ctx)).rejects.toMatchObject({retryable:false});
 await expect(tools.find(t=>t.name==='desktop_background_click')!.check!({app:selector,snapshotId:'s',ref:1,label:'approve'})).rejects.toMatchObject({retryable:false});
 expect(h.calls).toEqual([]);
});

it.each(['open','append','save'] as const)('document lifecycle stops on cursor-changed %s result without certifying later writes',async stage=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'document-cursor-'))),path=join(dir,'fixture.txt');writeFileSync(path,'old');
 const calls:string[]=[],receipts:{kind:string}[]=[];let value='old';
 class DocumentBridge extends Helper{
  constructor(){super('/unused');}
  override async permissions(){return {accessibility:true,screenRecording:true,calendars:false,reminders:false};}
  override async call(op:string){calls.push(op);if(op==='background_set_value')value+='new';if(op==='background_save_document')writeFileSync(path,value);
   return {pid:42,bundleId:'com.apple.TextEdit',processStartedAt:123,windowId:9,windowTitle:'fixture.txt',documentPath:path,controlMode:'backgroundStrict',snapshotId:'s',operationId:'native-op',status:op==='background_save_document'?'saved':'verified',foregroundChanged:false,cursorChanged:op===({open:'background_open_document',append:'background_set_value',save:'background_save_document'}[stage]),targets:[{ref:1,label:value,value,role:'AXTextArea',backgroundActions:['set-value']}]};
  }
 }
 try{
  const tool=createDesktopTools({helper:new DocumentBridge()}).find(t=>t.name==='desktop_background_document')!;
  await expect(tool.run({path,text:'new'},{...ctx,userGoal:`TextEdit arka planda ${path} belgesine "new" ekle ve kaydet.`,recordDesktopEvidence:e=>receipts.push(e)})).rejects.toMatchObject({deliveryUnknown:true});
  expect(calls).toHaveLength(stage==='open'?1:stage==='append'?2:3);expect(receipts.some(r=>r.kind==='verified-save')).toBe(false);if(stage==='append')expect(receipts.some(r=>r.kind==='verified-append')).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
