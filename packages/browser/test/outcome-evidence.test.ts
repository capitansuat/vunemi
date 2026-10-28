import {expect,it,vi} from 'vitest';
import {BrowserController} from '../src/controller.js';
import {createBrowserTools} from '../src/tools.js';
function fixture(){
 const browser=new BrowserController(async()=>{throw Error('No live browser permitted');});
 let target='owned-target',loaderId='document',url='https://example.com/form';
 const driver={strictState:vi.fn(async()=>({frameId:'main',loaderId,url,width:800,height:600,scale:1,scrollX:0,scrollY:0})),location:vi.fn(async()=>({url,title:'Independent title'})),fieldOutcome:vi.fn(async():Promise<{value:string;label?:string}|null>=>({value:'expected'})),ownerField:vi.fn(async():Promise<string|null>=>null)};
 const backend={connected:true,listTabs:vi.fn(async()=>[{targetId:target,url,title:'Independent title'}])};
 Object.assign(browser,{backend,current:target});
 vi.spyOn(browser as any,'page').mockImplementation(async()=>({driver,target}));
 const goto=vi.spyOn(browser,'goto').mockImplementation(async(_url,_newTab,capture)=>{capture?.(target);return 'Navigation returned';});
 const act=vi.spyOn(browser,'act').mockImplementation(async(_label,action)=>{await action(driver as any);return 'Action delivered';});
 const record=vi.fn();
 return{browser,driver,goto,act,record,backend,changeTarget(){target='other-target';Object.assign(browser,{current:target});},changeDocument(){loaderId='other-document';},setUrl(v:string){url=v;}};
}
it('records navigation only from independent matching URL/title readback, with hashes only',async()=>{
 const f=fixture();await (f.browser as any).gotoWithOutcome('https://example.com/form',false,f.record);
 expect(f.driver.location).toHaveBeenCalled();expect(f.record).toHaveBeenCalledTimes(1);
 expect(f.record.mock.calls[0]![0]).toMatchObject({version:1,domain:'browser',kind:'navigation',targetId:'owned-target',source:'controller-readback'});
 const proof=f.record.mock.calls[0]![0];expect(proof.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(proof.observedHash).toBe(proof.requestHash);
 expect(JSON.stringify(proof)).not.toContain('example.com');expect(JSON.stringify(proof)).not.toContain('Independent title');
});
it('does not certify navigation to a redirected wrong URL',async()=>{
 const f=fixture();f.setUrl('https://example.com/wrong');await (f.browser as any).gotoWithOutcome('https://example.com/form',false,f.record);expect(f.record).not.toHaveBeenCalled();
});
it('does not certify navigation if target changes during readback',async()=>{
 const f=fixture();f.driver.location.mockImplementationOnce(async()=>{f.changeTarget();return{url:'https://example.com/form',title:'Independent title'};});
 await (f.browser as any).gotoWithOutcome('https://example.com/form',false,f.record);expect(f.record).not.toHaveBeenCalled();
});
it('records exact field readback without persisting field text',async()=>{
 const f=fixture();await (f.browser as any).actWithFieldOutcome('Typed',async()=>{}, {ref:7,value:'expected',mode:'text'},f.record);
 expect(f.driver.fieldOutcome).toHaveBeenCalledWith(7);expect(f.record).toHaveBeenCalledTimes(1);expect(f.record.mock.calls[0]![0]).toMatchObject({kind:'field-value',targetId:'owned-target'});expect(JSON.stringify(f.record.mock.calls)).not.toContain('expected');
});
it('does not certify field mismatch or changed document',async()=>{
 const f=fixture();f.driver.fieldOutcome.mockResolvedValueOnce({value:'wrong',label:undefined});
 await (f.browser as any).actWithFieldOutcome('Typed',async()=>{},{ref:7,value:'expected',mode:'text'},f.record);expect(f.record).not.toHaveBeenCalled();
 await (f.browser as any).actWithFieldOutcome('Typed',async()=>{f.changeDocument();},{ref:7,value:'expected',mode:'text'},f.record);expect(f.record).not.toHaveBeenCalled();
});
it('never promotes strict click/no-op delivery or observation to outcome proof',async()=>{
 const recordOutcomeEvidence=vi.fn(),browser={actBound:async()=>({delivery:'delivered',verification:'observed',readback:{text:'unchanged'}})};
 const tool=createBrowserTools(browser as any).find(t=>t.name==='page_target_act')!;
 await tool.run({bindingId:'once',action:'click',ref:1},{runId:'r',signal:new AbortController().signal,assertToolActive(){},recordOutcomeEvidence} as any);
 expect(recordOutcomeEvidence).not.toHaveBeenCalled();
});
it('does not certify a closed target or challenge page',async()=>{
 const f=fixture();f.backend.listTabs.mockResolvedValueOnce([]);
 await f.browser.gotoWithOutcome('https://example.com/form',false,f.record);expect(f.record).not.toHaveBeenCalled();
 Object.assign(f.browser,{seenChallenge:'CAPTCHA'});
 await f.browser.gotoWithOutcome('https://example.com/form',false,f.record);expect(f.record).not.toHaveBeenCalled();
});
it('accepts exact selected label or value but refuses fuzzy selection matches',async()=>{
 const f=fixture();f.driver.fieldOutcome.mockResolvedValue({value:'uk',label:'United Kingdom'});
 await f.browser.actWithFieldOutcome('Selected',async()=>{},{ref:7,value:'United Kingdom',mode:'option'},f.record);
 await f.browser.actWithFieldOutcome('Selected',async()=>{},{ref:7,value:'uk',mode:'option'},f.record);
 expect(f.record).toHaveBeenCalledTimes(2);f.record.mockClear();
 await f.browser.actWithFieldOutcome('Selected',async()=>{},{ref:7,value:'United',mode:'option'},f.record);expect(f.record).not.toHaveBeenCalled();
});
it('refuses private owner fields and unavailable exact field readback',async()=>{
 const f=fixture();f.driver.ownerField.mockResolvedValueOnce('password');
 await f.browser.actWithFieldOutcome('Typed',async()=>{},{ref:7,value:'expected',mode:'text'},f.record);expect(f.record).not.toHaveBeenCalled();expect(f.driver.fieldOutcome).not.toHaveBeenCalled();
 f.driver.fieldOutcome.mockResolvedValueOnce(null);
 await f.browser.actWithFieldOutcome('Typed',async()=>{},{ref:7,value:'expected',mode:'text'},f.record);expect(f.record).not.toHaveBeenCalled();
});
it('does not treat page_type submit as field proof or submission proof',async()=>{
 const f=fixture(),recordOutcomeEvidence=vi.fn(),type=vi.fn(async()=>{});f.act.mockImplementationOnce(async(_label,action)=>{await action({type} as any);return 'submitted delivery';});
 const tool=createBrowserTools(f.browser).find(t=>t.name==='page_type')!;
 await tool.run({ref:7,text:'expected',submit:true},{recordOutcomeEvidence} as any);
 expect(type).toHaveBeenCalledWith(7,'expected',{submit:true});expect(recordOutcomeEvidence).not.toHaveBeenCalled();
});
