import {outcomeFingerprint,type QuotedSource} from '@vunemi/agent-core';
import {ComposerDrafts} from './composer-drafts.js';
export type QuoteOrigin={sessionId:string;runId:string;stepId:string;raw:string};
type QuoteState={sessions:{current:string};runs:readonly {runId:string;status:string;steps:readonly {stepId:string;text:string}[]}[]};
export const quoteSourceAnchor=(runId:string,stepId:string)=>`quote-source-${encodeURIComponent(JSON.stringify([runId,stepId]))}`;
export function quoteSourceCurrent(source:QuoteOrigin,state:QuoteState):boolean{
 const run=state.runs.find(r=>r.runId===source.runId),step=run?.steps.at(-1);
 return state.sessions.current===source.sessionId&&!!run&&['done','max_steps'].includes(run.status)&&step?.stepId===source.stepId&&step.text===source.raw;
}
export function selectedQuoteText(root:Pick<HTMLElement,'contains'>,selection:Selection|null,raw:string):{text:string}|{error:'unsupported'|'tooLong'}|null{
 if(!selection||selection.rangeCount!==1||selection.isCollapsed||!selection.anchorNode||!selection.focusNode||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
 const text=selection.toString();if(!text.trim())return null;
 if(text.length>2000)return{error:'tooLong'};
 if(!raw.includes(text))return{error:'unsupported'};
 return{text};
}
/** No dispatch: immutable selected text is staged only if source ownership survives hashing. */
export async function stageQuote(source:QuoteOrigin,text:string,getState:()=>QuoteState,drafts:ComposerDrafts,hash:(raw:string)=>Promise<string>=outcomeFingerprint):Promise<boolean>{
 if(!text.trim()||text.length>2000||!source.raw.includes(text)||!quoteSourceCurrent(source,getState()))return false;
 const priorQuote=drafts.read(source.sessionId).quote;
 const sourceHash=await hash(source.raw);
 if(!quoteSourceCurrent(source,getState())||drafts.read(source.sessionId).quote!==priorQuote)return false;
 const quote:QuotedSource=Object.freeze({version:1,sessionId:source.sessionId,runId:source.runId,stepId:source.stepId,text,sourceHash});
 drafts.change(source.sessionId,'quote',quote);return true;
}
