import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {NativeRecipeDriver,NativeRecipeBinding,NativeRecipeExecutionContext} from '@vunemi/mac';
import type {NativeRecipeSetupInput,NativeRecipeReadOffer,NativeRecipeOffer,SetupOwner,PrepareNativeRecipeRequest,ApproveNativeRecipeRequest,NativeRecipesSnapshot} from '../../shared/native-recipes.js';
import {NativeRecipeStore} from './store.js';
import {resolveNativeRecipeSlots} from './slots.js';
import type {NativeRecipeEpoch} from './types.js';
interface Pending {owner:SetupOwner;sender:number;input:NativeRecipeSetupInput;ats:number[];read:NativeRecipeReadOffer;generation:number;stage:'read'|'preparing'|'review'|'approving';offer?:NativeRecipeOffer;binding?:NativeRecipeBinding}
export class NativeRecipeController {
 private pending=new Map<number,Pending>();private generation=0;private senderGeneration=new Map<number,number>();private epoch:NativeRecipeEpoch;
 constructor(private store:NativeRecipeStore,private driver:NativeRecipeDriver,private epochNow:()=>Promise<NativeRecipeEpoch>,initial:NativeRecipeEpoch,private veto:(literal?:string)=>void){this.epoch=initial;}
 async synchronize(){const epoch=await this.epochNow();if(!isDeepStrictEqual(epoch,this.epoch)){this.generation++;this.pending.clear();this.epoch=epoch;this.store.invalidate('environment-changed',epoch);}return epoch;}
 cancelAllSetups(){this.generation++;for(const p of this.pending.values())this.store.cancelSetup(p.owner);this.pending.clear();}
 invalidate(){this.cancelAllSetups();this.store.invalidate('configuration-changed',this.epoch);}
 private context(p:Pending):NativeRecipeExecutionContext{return {runId:p.owner.setupCallId,signal:new AbortController().signal,assertActive:()=>this.current(p),beforeChild(){throw Error('Setup cannot dispatch input')},recordBackup(){throw Error('Setup cannot create backup')}};}
 private current(p:Pending){this.veto(p.input.literal);if(this.pending.get(p.sender)!==p||p.generation!==this.generation||Date.now()>= (p.offer?.expiresAt??p.read.expiresAt))throw Error('Native setup expired or changed');}
 cancel(sender:number,owner?:SetupOwner){const p=this.pending.get(sender);if(p&&owner&&!isDeepStrictEqual(owner,p.owner))throw Error('Foreign native setup');this.senderGeneration.set(sender,(this.senderGeneration.get(sender)??0)+1);if(!p)return;this.store.cancelSetup(p.owner);this.pending.delete(sender);}
 async targets(){this.veto();return this.driver.targets();}
 async begin(sender:number,input:NativeRecipeSetupInput){this.cancel(sender);const sequence=this.senderGeneration.get(sender);await this.synchronize();this.veto(input.literal);const generation=this.generation;const resolved=resolveNativeRecipeSlots(input.slots,input.timeZone,Date.now());if(resolved.kind==='needs-offset')return resolved;
  const targets=await this.driver.targets();this.veto();if(generation!==this.generation||sequence!==this.senderGeneration.get(sender))throw Error('Configuration changed');const target=targets.find(t=>t.path===input.target.path&&t.pid===input.target.pid&&t.windowId===input.target.windowId);if(!target)throw Error('Exact TextEdit target unavailable');
  const owner={setupSessionId:randomUUID(),setupCallId:randomUUID()};const read:NativeRecipeReadOffer={...owner,readOfferId:randomUUID(),revision:1,expiresAt:Date.now()+120_000,target,recipeId:input.recipeId};this.pending.set(sender,{owner,sender,input:structuredClone(input),ats:resolved.ats,read,generation,stage:'read'});return read;
 }
 private owned(sender:number,owner:SetupOwner){const p=this.pending.get(sender);if(!p||!isDeepStrictEqual(owner,p.owner))throw Error('Foreign native setup');this.current(p);return p;}
 async prepare(sender:number,req:PrepareNativeRecipeRequest){const p=this.owned(sender,{setupSessionId:req.setupSessionId,setupCallId:req.setupCallId});if(p.stage!=='read'||req.readOfferId!==p.read.readOfferId||req.readOfferRevision!==p.read.revision||req.decision!=='allow-preparation-read')throw Error('Stale preparation offer');p.stage='preparing';
  const binding=await this.driver.prepare(p.input.target,p.input.literal,this.context(p));this.current(p);await this.synchronize();this.current(p);p.binding=binding;p.offer=this.store.offer(p.owner,binding,p.input,p.ats,Date.now(),p.read.target.title);p.stage='review';return p.offer;
 }
 async approve(sender:number,req:ApproveNativeRecipeRequest):Promise<NativeRecipesSnapshot>{const p=this.owned(sender,{setupSessionId:req.setupSessionId,setupCallId:req.setupCallId});if(p.stage!=='review'||!p.offer||req.offerId!==p.offer.offerId||req.offerRevision!==p.offer.revision||!p.binding)throw Error('Stale native review');p.stage='approving';
  if(!await this.driver.revalidate(p.binding,this.context(p)))throw Error('Document changed before approval');await this.synchronize();this.current(p);const result=this.store.approve(req.offerId,req.offerRevision,p.owner);this.pending.delete(sender);return result;
 }
}
