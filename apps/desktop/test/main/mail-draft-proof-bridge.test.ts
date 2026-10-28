import {afterEach,expect,it,vi} from 'vitest';
import {DraftSaveUnverified,GraphMailAccount,type Draft} from '@vunemi/mail';
import {RemoteMailAccount} from '../../src/main/remote-mail.js';
import {serveMail} from '../../src/vault-process/mail.js';
const entry={id:'synthetic',provider:'outlook' as const,email:'sender@example.com',clientId:'11111111-2222-4333-8444-555555555555',addedAt:1};
const draft:Draft={to:['recipient@example.com'],subject:'Synthetic',body:'Synthetic body'};
afterEach(()=>vi.restoreAllMocks());
it('carries exact draft readback through main and the allowlisted Vault method without send or save',async()=>{
 const observed={id:'draft-1',account:entry.email,isDraft:true,draft};
 const verify=vi.spyOn(GraphMailAccount.prototype,'verifyDraft').mockResolvedValue(observed);
 const save=vi.spyOn(GraphMailAccount.prototype,'saveDraft');const send=vi.spyOn(GraphMailAccount.prototype,'send');
 const handlers=new Map<string,(...args:unknown[])=>unknown>();
 const vault={has:()=>true,adopt:vi.fn(),use:vi.fn()};
 serveMail({vault,register:(name:string,handler:any)=>handlers.set(name,handler)} as any);
 const call=vi.fn(async(method:string,args:any[])=>handlers.get(method)!(...args));
 const remote=new RemoteMailAccount({call} as any,entry);
 await expect(remote.verifyDraft('draft-1',draft)).resolves.toEqual(observed);
 expect(call).toHaveBeenCalledWith('mail.call',[entry,'verifyDraft',['draft-1',draft]],300000);
 expect(verify).toHaveBeenCalledWith('draft-1',draft);expect(save).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(vault.use).not.toHaveBeenCalled();
});
it('preserves typed partial draft state across only the mail-specific Vault bridge',async()=>{
 vi.spyOn(GraphMailAccount.prototype,'saveDraft').mockRejectedValue(new DraftSaveUnverified('partial-draft'));
 const handlers=new Map<string,(...args:unknown[])=>unknown>();serveMail({vault:{has:()=>true,adopt:vi.fn()},register:(name:string,handler:any)=>handlers.set(name,handler)} as any);
 const remote=new RemoteMailAccount({call:async(method:string,args:any[])=>handlers.get(method)!(...args)} as any,entry);
 await expect(remote.saveDraft(draft)).rejects.toMatchObject({name:'DraftSaveUnverified',id:'partial-draft'});
});
