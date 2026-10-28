import {t} from '@vunemi/i18n';
import type {NativeRecipeDriver,NativeRecipeSlotResult} from '@vunemi/mac';
import type {AgentSession} from '../session.js';
import {NativeRecipeStore} from './store.js';
import type {NativeRecipeClaim} from './types.js';
export async function runNativeRecipe(claim:NativeRecipeClaim,deps:{store:NativeRecipeStore;driver:NativeRecipeDriver;session:Pick<AgentSession,"startNativeRecipe">;veto:(literal?:string)=>void;beforeRun?:()=>void|Promise<void>}):Promise<void>{
 const {store,driver,session}=deps,detail=store.inspect(claim),callId=detail.runId+'.recipe',at=()=>Date.now();
 // The process facade reserves its native lane before executing the callback.
 try{deps.veto(detail.literal);await deps.beforeRun?.();}catch{store.complete(claim,{status:'no-input',dispatchIds:[],reasonCode:'policy-blocked'});return;}
 let entered=false;
 try{await session.startNativeRecipe({runId:detail.runId,goal:`${t('nativeRecipes.title')}: ${detail.binding.target.path}`,execute:async(signal,emit)=>{
  entered=true;
  emit({type:'tool.proposed',runId:detail.runId,stepId:detail.runId+'.s0',callId,tool:'native_recipe_textedit_append_save',args:{path:detail.binding.target.path,slotId:detail.slotId},actionClass:'outbound',filePath:detail.binding.target.path});
  emit({type:'tool.started',runId:detail.runId,callId,at:at()});
  const active=()=>{if(signal.aborted)throw Error('stopped');try{deps.veto(detail.literal);}catch{throw Error('policy-blocked');}store.assert(claim);};
  let result:NativeRecipeSlotResult;
  try{active();result=await driver.execute(detail.binding,detail.literal,detail.backupPath,{runId:detail.runId,signal,expiresAt:detail.expiresAt,assertActive:active,beforeChild:(phase,id)=>{active();store.linkChild(claim,phase,id);if(phase==='append')emit({type:'desktop.append-intent',runId:detail.runId,callId,at:at()});},recordBackup:(path,hash)=>{active();store.recordBackup(claim,path,hash);}});}
  catch(e){const slot=store.snapshot().recipes.find(r=>r.automationId===detail.automationId)?.slots.find(s=>s.slotId===detail.slotId);result={status:slot?.dispatchIds.length?'unknown':slot?.backupCreated?'backup-only':'no-input',dispatchIds:slot?.dispatchIds??[],...(slot?.backupCreated?{backup:{path:detail.backupPath,sha256:''}}:{}),reasonCode:e instanceof Error?e.message:'recipe-failed'};}
  if(signal.aborted){try{store.revoke({automationId:detail.automationId,expectedRevision:store.snapshot().revision});}catch{/* Preserve evidence even when permission already ended. */}}
  try{store.complete(claim,result);}catch(error){if(result.status!=='verified')throw error;result={status:'unknown',backup:result.backup,dispatchIds:result.dispatchIds,reasonCode:'authority-ended-after-dispatch'};store.complete(claim,result);}
  if(result.status==='verified'){
   for(const [index,evidence] of (result.receipts??[]).entries())emit({type:'desktop.receipt',runId:detail.runId,callId,receiptId:callId+'.proof'+index,evidence,at:at()});
   emit({type:'tool.finished',runId:detail.runId,callId,ok:true,output:JSON.stringify({status:'saved-and-verified',path:detail.binding.target.path,dispatchIds:result.dispatchIds}),display:t('nativeRecipes.slotStatus.verified'),produced:[{kind:'file',path:detail.binding.target.path}],fileEvidence:{path:detail.binding.target.path,kind:'verified-read',checks:{recipe:'textedit.append-save.v1',sha256:result.afterBinding.version.sha256}},desktopEvidence:result.receipts?.find(r=>r.kind==='verified-save'),durationMs:0});
   emit({type:'task.progress',runId:detail.runId,step:1,status:'completed',evidenceCallIds:[callId],at:at()});return 'done';
  }
  emit({type:'tool.finished',runId:detail.runId,callId,ok:false,output:JSON.stringify(result),display:result.reasonCode??result.status,...(result.status==='unknown'?{deliveryUnknown:true}:{}),durationMs:0});return signal.aborted?'stopped':'failed';
 }});}catch(error){if(entered)throw error;store.complete(claim,{status:'no-input',dispatchIds:[],reasonCode:'session-unavailable'});}
}
