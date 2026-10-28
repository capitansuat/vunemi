import {Helper} from '@vunemi/mac';
import {KeyCrypto} from '@vunemi/vault';
interface KeyHelper {
 call(op:string,args:Record<string,unknown>,opts:{timeoutMs:number}):Promise<unknown>;
 dispose():void;
}
/** No automatic permission dialog. Only the explicit Vault button may prompt. */
export class VaultUnlock {
 private pending:Promise<void>|null=null;
 constructor(private readonly crypto:KeyCrypto,private readonly createHelper:()=>KeyHelper) {}
 unlock(interactive=false):Promise<void> {
  if(this.crypto.available)return Promise.resolve();
  if(this.pending)return this.pending;
  const pending=this.read(interactive);this.pending=pending;
  void pending.finally(()=>{if(this.pending===pending)this.pending=null;}).catch(()=>undefined);
  return pending;
 }
 private async read(interactive:boolean):Promise<void> {
  const helper=this.createHelper();
  try {
   const result=await helper.call('vault_key',{create:true,interactive},{timeoutMs:interactive?300000:5000}) as {key?:unknown};
   if(typeof result.key!=='string')throw Error('No vault key returned.');
   this.crypto.unlock(Buffer.from(result.key,'base64'));
  } finally {helper.dispose();}
 }
}
export const keyBroker=(crypto:KeyCrypto,path:string):VaultUnlock=>new VaultUnlock(crypto,()=>new Helper(path));
