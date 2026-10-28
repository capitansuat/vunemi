import { nativeRecipeTime } from '../lib/native-recipes.js';
import { useState } from 'react';
import { t } from '@vunemi/i18n';
import { useStore } from '../store.js';
import { NativeRecipeSetup } from './NativeRecipeSetup.js';
export function NativeRecipePermissions({runIds}:{runIds?:string[]}) {
 useStore(s=>s.locale);
 const snapshot=useStore(s=>s.nativeRecipes),revoking=useStore(s=>s.nativeRecipeRevoking),error=useStore(s=>s.nativeRecipeActionError),loadError=useStore(s=>s.nativeRecipeLoadError);
 const [setup,setSetup]=useState(false);
 const rows=snapshot?.recipes.filter(r=>!runIds||r.slots.some(s=>s.runId!==undefined&&runIds.includes(s.runId)));
 if(runIds&&!rows?.length)return null;
 return <section data-native-recipes-stream={snapshot?.streamId} data-native-recipes-revision={snapshot?.revision} className="my-4 space-y-3" aria-label={t('nativeRecipes.title')}>
 {!runIds&&<><h2 className="text-sm font-medium text-fg">{t('nativeRecipes.title')}</h2><button type="button" className="rounded-md border border-line px-3 py-1 text-sm text-fg" onClick={()=>setSetup(true)}>{t('nativeRecipes.setup')}</button>{setup&&<NativeRecipeSetup onClose={()=>setSetup(false)} />}</>}
 <ul className="space-y-2">{rows?.map(row=><li key={row.automationId} className="rounded-xl border border-line p-3 text-sm text-muted">
 <p className="break-all text-fg">{row.title} · <bdi>{row.target.path}</bdi></p><p role="status" aria-live="polite">{t(`nativeRecipes.authority.${row.authorityStatus}`)} · {t('nativeRecipes.remaining',{count:row.remainingSlots})}</p>
 <p>{t('nativeRecipes.expires',{at:nativeRecipeTime(row.expiresAt,row.timeZone)})}</p>
 {row.slots.find(s=>s.status==='scheduled')&&<p>{t('nativeRecipes.next',{at:nativeRecipeTime(row.slots.find(s=>s.status==='scheduled')!.at,row.timeZone)})}</p>}
 <div aria-live="polite" className="space-y-1">{row.slots.filter(slot=>slot.status==='unknown'||slot.status==='backup-only').map(slot=><div key={slot.slotId} role="status" className={`break-all rounded-md border border-line p-2 ${slot.status==='unknown'?'text-warn':'text-muted'}`}><p>{nativeRecipeTime(slot.at,row.timeZone)} · {t(`nativeRecipes.slotStatus.${slot.status}`)}</p>{slot.reason&&<p>{slot.reason}</p>}{slot.backupCreated&&<p><bdi>{t('nativeRecipes.backup',{path:slot.backupPath})}</bdi></p>}</div>)}</div>
 <details><summary>{t('nativeRecipes.review')}</summary><pre dir="auto" style={{unicodeBidi:'isolate'}} className="whitespace-pre-wrap break-all">{row.literal}</pre><p>{row.timeZone}</p><ol>{row.slots.map(slot=><li key={slot.slotId} className="break-all">{nativeRecipeTime(slot.at,row.timeZone)} · {t(`nativeRecipes.slotStatus.${slot.status}`)}{slot.reason&&` · ${slot.reason}`}{slot.backupCreated&&<p>{t('nativeRecipes.backup',{path:slot.backupPath})}</p>}</li>)}</ol></details>
 <button type="button" disabled title={t('nativeRecipes.runNowDisabled')} className="mr-3 opacity-50">{t('automations.runNow')}</button><span>{t('nativeRecipes.runNowDisabled')}</span>
 {row.authorityStatus!=='revoked'&&<button type="button" aria-busy={revoking===row.automationId} aria-label={`${t('nativeRecipes.revoke')}: ${row.target.path}`} disabled={revoking!==null} className="ml-3 rounded border border-line px-2 py-1 disabled:opacity-50" onClick={()=>void useStore.getState().revokeNativeRecipe(row.automationId)}>{t(revoking===row.automationId?'nativeRecipes.revoking':'nativeRecipes.revoke')}</button>}
 </li>)}</ul>{error&&<p role="alert">{error}</p>}{!runIds&&loadError&&<p role="alert">{loadError}</p>}
 </section>;
}
