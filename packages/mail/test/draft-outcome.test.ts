import {expect,it,vi} from 'vitest';
import {MailAccounts} from '../src/accounts.js';import {Outbox} from '../src/outbox.js';import {createMailTools} from '../src/tools.js';
import {DraftSaveUnverified} from '../src/types.js';
const draft={to:['recipient@example.com'],cc:['copy@example.com'],subject:'Synthetic',body:'Synthetic body'};
function fixture(change:Record<string,unknown>={},id='draft-1',readError=false){
 const saveDraft=vi.fn(async()=>({id}));const verifyDraft=vi.fn(async()=>{if(readError)throw Error('read unavailable');return {id,account:'sender@example.com',isDraft:true,draft:{...draft},...change};});
 const account:any={label:'sender@example.com',ready:async()=>true,saveDraft,verifyDraft};
 const accounts=new MailAccounts();accounts.add({id:'account-1',label:'Synthetic account',account});
 const tool=createMailTools({accounts,outbox:new Outbox()}).find(t=>t.name==='mail_draft')!;
 const receipt=vi.fn();const ctx:any={signal:new AbortController().signal,offerUndo:vi.fn(),produced:vi.fn(),recordOutcomeEvidence:receipt};
 return {tool,ctx,receipt,saveDraft,verifyDraft,account};
}
it('records proof only after fresh account/draft identity and content verification',async()=>{
 const f=fixture();const out=await f.tool.run(draft,f.ctx);
 expect(f.verifyDraft).toHaveBeenCalledWith('draft-1',draft);expect(f.receipt).toHaveBeenCalledOnce();
 const proof=f.receipt.mock.calls[0]![0];expect(proof).toMatchObject({domain:'mail-draft',kind:'draft-saved',source:'controller-readback'});expect(proof.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(proof.observedHash).toBe(proof.requestHash);expect(JSON.stringify(proof)).not.toContain('Synthetic body');expect(out).toContain('independently verified');
});
it.each([{id:'other'},{account:'other@example.com'},{isDraft:false},{draft:{...draft,subject:'changed'}},{draft:{...draft,body:'changed'}},{draft:{...draft,to:['unexpected@example.com']}},{draft:{...draft,cc:[]}}])('does not certify mismatched draft readback %j',async change=>{
 const f=fixture(change);const out=await f.tool.run(draft,f.ctx);expect(f.receipt).not.toHaveBeenCalled();expect(out).toContain('not independently verified');expect(f.saveDraft).toHaveBeenCalledOnce();
});
it.each(['no-id','unsupported','read-error'])('keeps %s saved-unverified without retrying mutation',async mode=>{
 const f=fixture({},mode==='no-id'?'':'draft-1',mode==='read-error');if(mode==='unsupported')delete f.account.verifyDraft;
 const out=await f.tool.run(draft,f.ctx);expect(f.receipt).not.toHaveBeenCalled();expect(out).toContain('not independently verified');expect(f.saveDraft).toHaveBeenCalledOnce();if(mode==='no-id')expect(f.verifyDraft).not.toHaveBeenCalled();
});
it('does not certify or reread after Stop arrives during the acknowledged save',async()=>{
 const f=fixture();const abort=new AbortController();f.ctx.signal=abort.signal;
 f.saveDraft.mockImplementationOnce(async()=>{abort.abort();return {id:'draft-1'};});
 const out=await f.tool.run(draft,f.ctx);expect(out).toContain('not independently verified');expect(f.saveDraft).toHaveBeenCalledOnce();expect(f.verifyDraft).not.toHaveBeenCalled();expect(f.receipt).not.toHaveBeenCalled();
});
it('handles a typed partial save without retrying or fabricating a completed draft',async()=>{
 const f=fixture();f.saveDraft.mockRejectedValueOnce(new DraftSaveUnverified());
 const out=await f.tool.run(draft,f.ctx);expect(out).toContain('not independently verified');expect(f.saveDraft).toHaveBeenCalledOnce();expect(f.verifyDraft).not.toHaveBeenCalled();expect(f.receipt).not.toHaveBeenCalled();
});
