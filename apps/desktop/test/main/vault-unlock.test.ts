import {it,expect,vi} from 'vitest';
import {KeyCrypto} from '@vunemi/vault';
import {VaultUnlock} from '../../src/vault-process/unlock.js';
const key=Buffer.alloc(32,7).toString('base64');
it('starts without permission UI and uses the existing key',async()=>{
 const call=vi.fn().mockResolvedValue({key}),dispose=vi.fn();const crypto=new KeyCrypto();
 const broker=new VaultUnlock(crypto,()=>({call,dispose}));await broker.unlock();
 expect(call).toHaveBeenCalledExactlyOnceWith('vault_key',{create:true,interactive:false},{timeoutMs:5000});
 expect(crypto.available).toBe(true);expect(dispose).toHaveBeenCalledOnce();
});
it('never retries or replaces the key after silent refusal',async()=>{
 const call=vi.fn().mockRejectedValue(Error('interaction not allowed')),dispose=vi.fn();const crypto=new KeyCrypto();
 const broker=new VaultUnlock(crypto,()=>({call,dispose}));await expect(broker.unlock()).rejects.toThrow('interaction not allowed');
 expect(call).toHaveBeenCalledOnce();expect(crypto.available).toBe(false);expect(dispose).toHaveBeenCalledOnce();
});
it('makes one key request after explicit unlock and merges double clicks',async()=>{
 let resolve!:(v:unknown)=>void;const call=vi.fn().mockImplementation(()=>new Promise(r=>{resolve=r;})),dispose=vi.fn();
 const crypto=new KeyCrypto(),broker=new VaultUnlock(crypto,()=>({call,dispose}));const first=broker.unlock(true),second=broker.unlock(true);
 expect(call).toHaveBeenCalledExactlyOnceWith('vault_key',{create:true,interactive:true},{timeoutMs:300000});
 resolve({key});await Promise.all([first,second]);expect(dispose).toHaveBeenCalledOnce();
 await broker.unlock(true);expect(call).toHaveBeenCalledOnce();
});
it('keeps a malformed key locked and never exposes it in an error',async()=>{
 const crypto=new KeyCrypto(),call=vi.fn().mockResolvedValue({key:'bad-key'}),dispose=vi.fn();
 const broker=new VaultUnlock(crypto,()=>({call,dispose}));await expect(broker.unlock(true)).rejects.toThrow('32 bytes');
 expect(crypto.available).toBe(false);expect(dispose).toHaveBeenCalledOnce();
});

it('preserves encrypted entries through silent refusal and explicit unlock',async()=>{
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {Vault}=await import('@vunemi/vault');
 const dir=mkdtempSync(join(tmpdir(),'vunemi-vault-unlock-'));
 try {
  const original=new KeyCrypto();original.unlock(Buffer.from(key,'base64'));new Vault(dir,original).set('fixture-key','synthetic-value');
  const before=readFileSync(join(dir,'vault.json'));const crypto=new KeyCrypto();const vault=new Vault(dir,crypto);
  const call=vi.fn().mockImplementation(async(_op,args)=>{if(!args.interactive)throw Error('interaction not allowed');return {key};});
  const broker=new VaultUnlock(crypto,()=>({call,dispose:vi.fn()}));await expect(broker.unlock()).rejects.toThrow();
  expect(readFileSync(join(dir,'vault.json'))).toEqual(before);expect(vault.unreadable()).toHaveLength(1);
  await broker.unlock(true);expect(vault.reopen().opened).toEqual(['fixture-key']);
  expect(readFileSync(join(dir,'vault.json'))).toEqual(before);
  expect(vault.use('fixture-key')).toBe('synthetic-value');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
