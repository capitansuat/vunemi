import { nativeRecipeTime } from '../lib/native-recipes.js';
import { useEffect, useRef, useState } from 'react';
import { t } from '@vunemi/i18n';
import type { LocalSlot, NativeRecipeTargetView } from '../../../shared/native-recipes.js';
import { useStore } from '../store.js';
const button='rounded-md border border-line px-3 py-1.5 text-sm text-fg focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50';
export function NativeRecipeSetup({onClose}:{onClose:()=>void}) {
 const mounted=useRef(true),draft=useRef(0);
 const draftGeneration=draft.current;
 useStore(s=>s.locale);
 const setup=useStore(s=>s.nativeRecipeSetup),error=useStore(s=>s.nativeRecipeActionError);
 const [targets,setTargets]=useState<NativeRecipeTargetView[]>([]),[target,setTarget]=useState(''),[literal,setLiteral]=useState(''),[zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone),[slots,setSlots]=useState<LocalSlot[]>([{local:''}]),[loadError,setLoadError]=useState(''),[now,setNow]=useState(Date.now());
 useEffect(()=>{mounted.current=true;let live=true;void window.vunemi.nativeRecipeTargets().then(rows=>{if(live)setTargets(rows);}).catch(e=>{if(live)setLoadError(String(e));});const timer=setInterval(()=>setNow(Date.now()),500);return()=>{mounted.current=false;++draft.current;live=false;clearInterval(timer);void useStore.getState().cancelNativeRecipeSetup();};},[]);
 const change=(fn:()=>void)=>{++draft.current;void useStore.getState().cancelNativeRecipeSetup();fn();};
 const close=()=>{mounted.current=false;++draft.current;void useStore.getState().cancelNativeRecipeSetup();onClose();};
 const read=setup?.read,offer=setup?.offer,expired=(offer??read)?.expiresAt!==undefined&&(offer??read)!.expiresAt<=now;
 const chosen=targets.find((_,i)=>String(i)===target);
 const valid=chosen&&literal.length>=1&&literal.length<=256&&slots.length>=1&&slots.length<=4&&slots.every(s=>s.local);
 return <section aria-label={t('nativeRecipes.setup')} className="space-y-3 rounded-xl border border-line p-4 text-sm text-fg">
 <h2>{t('nativeRecipes.title')}</h2><p className="text-muted">{t('nativeRecipes.intro')}</p>
 <label className="block">{t('nativeRecipes.target')}<select className="mt-1 block w-full bg-surface" value={target} disabled={setup?.busy} onChange={e=>change(()=>setTarget(e.target.value))}><option value="">{t('nativeRecipes.target')}</option>{targets.map((r,i)=><option key={`${r.pid}:${r.windowId}:${r.path}`} value={i}>{r.path} · PID {r.pid} · {r.windowId} · {r.title}</option>)}</select></label>
 {!targets.length&&<p>{t('nativeRecipes.noTargets')}</p>}
 <label className="block">{t('nativeRecipes.literal')}<textarea value={literal} maxLength={256} disabled={setup?.busy} onChange={e=>change(()=>setLiteral(e.target.value))} className="mt-1 block min-h-24 w-full whitespace-pre-wrap break-all bg-surface" dir="auto" /><span className="text-xs text-muted">{literal.length} / 256 UTF-16</span></label>
 <label className="block">{t('nativeRecipes.timezone')}<input value={zone} disabled={setup?.busy} onChange={e=>change(()=>setZone(e.target.value))} className="block w-full bg-surface" /></label>
 {slots.map((slot,i)=><div key={i} className="flex flex-wrap gap-2"><label>{t('nativeRecipes.slot',{count:i+1})}<input type="datetime-local" value={slot.local} disabled={setup?.busy} onChange={e=>change(()=>setSlots(slots.map((s,j)=>j===i?{local:e.target.value}:s)))} className="block bg-surface" /></label>
 {(setup?.offsets?.choices.find(c=>c.index===i)||slot.offsetMinutes!==undefined)&&<label>{t('nativeRecipes.offset')}<select disabled={setup?.busy} value={slot.offsetMinutes??''} onChange={e=>{const value=e.target.value;change(()=>setSlots(slots.map((s,j)=>j===i?{...s,offsetMinutes:value===''?undefined:Number(value)}:s)));}} className="block bg-surface"><option value="">{t('nativeRecipes.offsetRequired')}</option>{(setup?.offsets?.choices.find(c=>c.index===i)?.offsetMinutes??[slot.offsetMinutes!]).map(offset=><option key={offset} value={offset}>UTC{offset<0?'-':'+'}{Math.floor(Math.abs(offset)/60).toString().padStart(2,'0')}:{(Math.abs(offset)%60).toString().padStart(2,'0')}</option>)}</select></label>}
 {slots.length>1&&<button type="button" disabled={setup?.busy} onClick={()=>change(()=>setSlots(slots.filter((_,j)=>i!==j)))} className={button}>{t('nativeRecipes.removeSlot')}</button>}</div>)}
 <button type="button" disabled={slots.length>=4||setup?.busy} className={button} onClick={()=>change(()=>setSlots([...slots,{local:''}]))}>{t('nativeRecipes.addSlot')}</button>
 {!read&&!offer&&<button type="button" disabled={!valid||setup?.busy} className={button} onClick={()=>{if(mounted.current&&draft.current===draftGeneration&&chosen)void useStore.getState().beginNativeRecipeSetup({recipeId:'textedit.append-save.v1',target:{path:chosen.path,pid:chosen.pid,windowId:chosen.windowId},literal,timeZone:zone,slots});}}>{t('nativeRecipes.reviewRead')}</button>}
 {read&&<div className="space-y-2 border-t border-line pt-3"><p>{t('nativeRecipes.readConsent')}</p><p className="break-all"><bdi>{read.target.path}</bdi> · PID {read.target.pid} · {read.target.windowId} · {read.target.title}</p><button type="button" className={button} disabled={expired||setup?.busy||setup?.failed} onClick={()=>{if(useStore.getState().nativeRecipeSetup===setup&&read.expiresAt>Date.now())void useStore.getState().prepareNativeRecipe();}}>{t('nativeRecipes.prepare')}</button></div>}
 {offer&&<div className="space-y-2 border-t border-line pt-3"><h3>{t('nativeRecipes.review')}</h3><p className="break-all"><bdi>{offer.target.path}</bdi> · PID {offer.target.pid} · {offer.target.windowId} · {offer.target.title}</p><pre className="whitespace-pre-wrap break-all" style={{unicodeBidi:'isolate'}} dir="auto">{offer.literal}</pre><p>{offer.timeZone}</p><p>{t('nativeRecipes.backupCount',{count:offer.slots.length})}</p><ol>{offer.slots.map(s=><li key={s.slotId} className="break-all">{nativeRecipeTime(s.at,offer.timeZone)} · {new Date(s.at).toISOString()}<p>{t('nativeRecipes.backup',{path:s.backupPath})}</p></li>)}</ol><p>{t('nativeRecipes.expires',{at:nativeRecipeTime(offer.authorityExpiresAt,offer.timeZone)})}</p><p>{t('nativeRecipes.limits')}</p><button type="button" className={button} disabled={expired||setup?.busy||setup?.failed} onClick={()=>{if(useStore.getState().nativeRecipeSetup===setup&&offer.expiresAt>Date.now())void useStore.getState().approveNativeRecipe();}}>{t('nativeRecipes.approve')}</button></div>}
 {expired&&<p role="status">{t('nativeRecipes.expired')}</p>}{setup?.failed&&!expired&&<p role="status">{t('nativeRecipes.failed')}</p>}{setup?.busy&&<p role="status">{t('nativeRecipes.busy')}</p>}{(error||loadError)&&<p role="alert">{error||loadError}</p>}
 <button autoFocus type="button" className={button} onClick={close}>{t('nativeRecipes.cancel')}</button>
 </section>;
}
