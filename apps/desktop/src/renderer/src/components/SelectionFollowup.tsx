import {useRef,useState,type ReactNode} from 'react';
import {t} from '@vunemi/i18n';
import {useStore} from '../store.js';
import {composerDrafts} from '../lib/composer-drafts.js';
import {quoteSourceAnchor,quoteSourceCurrent,selectedQuoteText,stageQuote,type QuoteOrigin} from '../lib/selection-followup.js';
/** Scoped to a single completed assistant message; selection never dispatches. */
export function SelectionFollowup({source,children}:{source:QuoteOrigin;children:ReactNode}){
 const root=useRef<HTMLDivElement>(null),[selection,setSelection]=useState<ReturnType<typeof selectedQuoteText>>(null),[busy,setBusy]=useState(false);
 const capture=()=>{if(!root.current||!quoteSourceCurrent(source,useStore.getState())){setSelection(null);return;}setSelection(selectedQuoteText(root.current,window.getSelection(),source.raw));};
 const quote=async()=>{if(busy||!selection||!('text' in selection))return;setBusy(true);try{if(await stageQuote(source,selection.text,useStore.getState,composerDrafts)){setSelection(null);requestAnimationFrame(()=>{if(quoteSourceCurrent(source,useStore.getState()))document.querySelector<HTMLTextAreaElement>('[data-composer-question]')?.focus();});}}catch{setSelection({error:'unsupported'});}finally{setBusy(false);}};
 return <div onMouseUp={capture} onKeyUp={e=>{if(e.key!=='Escape')capture();}} onKeyDown={e=>{if(e.key==='Escape'&&selection){e.preventDefault();e.stopPropagation();setSelection(null);}}}>
  <div ref={root} id={quoteSourceAnchor(source.runId,source.stepId)} tabIndex={-1} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ember">{children}</div>
  {selection&&<div className="mt-2 flex items-center gap-2" role="status">{'error' in selection?<p className="text-[12px] text-muted">{t(`quotedSource.${selection.error}`)}</p>:<button type="button" disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>void quote()} className="rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1 text-[12px] text-fg hover:border-ember focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50">{t('quotedSource.action')}</button>}</div>}
 </div>;
}
