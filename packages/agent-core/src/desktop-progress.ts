import type {TaskRecord,TaskProgressInput} from './tasks.js';
/** Native-backed local receipts. Never inferred from model prose or JSON output. */
export interface DesktopEvidence {
 version:1; kind:'observation'|'verified-append'|'verified-save';
 bundleId:string;processStartedAt:number;windowId:number;windowTitle:string;fieldRef:number;
 documentPath?:string;requestedPath?:string;diskHash?:string;diskBeforeHash?:string;
 valueHash:string;beforeHash?:string;appendedText?:string;operationId?:string;
}
export interface DesktopAppendWorkflow {title:string;text:string;steps:string[];path?:string}
/** A single explicit, bounded background append workflow. Arbitrary/edited
 * desktop plans retain manual progress; never guess what an app step means. */
export function desktopDocumentWorkflow(goal:string):DesktopAppendWorkflow|null {
 if(!/\bTextEdit\b/i.test(goal)||!/arka\s*plan|background|oda[ğg].*değiş/iu.test(goal)||!/ekle|append/iu.test(goal)||!/kaydet|save/iu.test(goal))return null;
 const paths=[...new Set([...goal.matchAll(/(?:\/[^\s"“”«»`]+)+\.txt\b/gu)].map(m=>m[0]))];
 const quoted=[...goal.matchAll(/["“«]([^"”»]+)["”»]/gu)].map(m=>m[1]!).filter(v=>!paths.includes(v));
 if(paths.length!==1||quoted.length!==1||!quoted[0]||quoted[0].length>2000)return null;
 const resources=[...new Set([...goal.matchAll(/[^\s/"“”«»`]+\.(?:txt|md|docx|rtf|pdf|csv|xlsx|pptx|json)\b/giu)].map(m=>m[0]))];
 if(resources.length!==1||/\b(?:Calculator|Outlook|Teams|Safari|Excel|email|gönder|sil|delete|send|upload|publish)\b/iu.test(goal))return null;
 const path=paths[0]!,title=path.split('/').at(-1)!;
 return {path,title,text:quoted[0]!,steps:[`${title}: belgeyi odağı değiştirmeden aç.`,`${title}: istenen metni tek kez ekle.`,`${title}: kaydet ve diskteki içeriği doğrula.`]};
}
export function desktopAppendWorkflow(goal:string):DesktopAppendWorkflow|null {
 const document=desktopDocumentWorkflow(goal);if(document)return document;
 if(!/\bTextEdit\b/i.test(goal)||!/arka\s*plan|background/iu.test(goal)||!goal.includes('desktop_background_append_text')||!/yalnız|only/iu.test(goal))return null;
 if(/(?:\/|~\/)[^\s"“”«»`]*\.txt\b/u.test(goal))return null;
 const names=[...new Set([...goal.matchAll(/[^\s/"“”«»`]+\.txt\b/gu)].map(m=>m[0]))];
 const texts=[...goal.matchAll(/["“«]([^"”»]+)["”»]/gu)].map(m=>m[1]!).filter(text=>!names.includes(text));
 const toolNames=[...goal.matchAll(/\bdesktop_[a-z_]+\b/g)].map(m=>m[0]);
 const resources=[...new Set([...goal.matchAll(/[^\s/"“”«»`]+\.(?:txt|md|docx|rtf|pdf|csv|xlsx|pptx|json)\b/giu)].map(m=>m[0]))];
 if(resources.length!==1)return null;
 if(names.length!==1||texts.length!==1||!texts[0]||texts[0].length>2000||toolNames.some(n=>!['desktop_windows','desktop_background_describe','desktop_background_append_text'].includes(n)))return null;
 // Additional destinations/actions cannot be silently absorbed by this plan.
 if(/\b(?:Calculator|Outlook|Teams|Safari|Excel|mail|email|gönder|sil|delete|send|upload|publish)\b/iu.test(goal))return null;
 const title=names[0]!,text=texts[0]!;
 return {title,text,steps:[`${title}: doğru pencereyi gözle.`,`${title}: istenen metni arka planda ekle.`,`${title}: gerçek alan değerini doğrula.`]};
}
export function desktopBindings(task:TaskRecord):DesktopAppendWorkflow|null {
 const spec=desktopAppendWorkflow(task.goal);
 return spec&&task.planAccepted&&spec.steps.length===task.steps.length&&spec.steps.every((s,i)=>s===task.steps[i]!.title)?spec:null;
}
export function validDesktopEvidence(e:DesktopEvidence):boolean {
 return e.version===1&&['observation','verified-append','verified-save'].includes(e.kind)&&e.bundleId==='com.apple.TextEdit'
  &&Number.isFinite(e.processStartedAt)&&e.processStartedAt>0&&Number.isInteger(e.windowId)&&e.windowId>0
  &&Number.isInteger(e.fieldRef)&&e.fieldRef>0&&typeof e.windowTitle==='string'&&/^[a-f0-9]{64}$/.test(e.valueHash)
  &&(e.documentPath===undefined||typeof e.documentPath==='string'&&e.documentPath.startsWith('/'))
  &&(e.kind==='observation'||e.kind==='verified-save'&&!!e.documentPath&&e.diskHash===e.valueHash&&!!e.operationId||(typeof e.appendedText==='string'&&typeof e.operationId==='string'&&!!e.operationId&&/^[a-f0-9]{64}$/.test(e.beforeHash??'')));
}
export function sameDesktopField(a:DesktopEvidence,b:DesktopEvidence):boolean {
 return a.bundleId===b.bundleId&&a.processStartedAt===b.processStartedAt&&a.windowId===b.windowId&&a.windowTitle===b.windowTitle&&a.fieldRef===b.fieldRef;
}
export function desktopWrite(task:TaskRecord,spec:DesktopAppendWorkflow) {
 return task.operations.findLast(o=>o.status==='completed'&&o.tool==='desktop_background_append_text'&&o.desktopEvidence?.kind==='verified-append'
  &&validDesktopEvidence(o.desktopEvidence)&&o.desktopEvidence.windowTitle===spec.title
  &&[spec.text,'\n'+spec.text,spec.text+'\n','\n'+spec.text+'\n'].includes(o.desktopEvidence.appendedText!));
}
export function automaticDesktopCompletions(task:TaskRecord,spec:DesktopAppendWorkflow):TaskProgressInput[] {
 if(spec.path){
  const receipts=task.operations.filter(o=>o.status==='completed'&&o.tool==='desktop_background_document'&&(o.desktopEvidence?.requestedPath??o.desktopEvidence?.documentPath)===spec.path&&validDesktopEvidence(o.desktopEvidence!));
  const read=receipts.findLast(o=>o.desktopEvidence!.kind==='observation'&&o.runId===task.activeRunId);
  const write=receipts.findLast(o=>o.desktopEvidence!.kind==='verified-append'&&o.desktopEvidence!.appendedText===spec.text);
  const save=receipts.findLast(o=>o.desktopEvidence!.kind==='verified-save'&&o.runId===task.activeRunId&&o.desktopEvidence!.valueHash===write?.desktopEvidence!.valueHash);
  return ([read,write,save] as const).flatMap((o,i)=>o&&(task.steps[i]?.status!=='completed'||task.steps[i]?.evidence!=='tool_result')?[{step:i+1,status:'completed' as const,evidenceCallIds:[o.callId]}]:[]);
 }
 const updates:TaskProgressInput[]=[];
 const reads=task.operations.filter(o=>o.status==='completed'&&o.tool==='desktop_background_describe'&&o.desktopEvidence?.kind==='observation'&&validDesktopEvidence(o.desktopEvidence)&&o.desktopEvidence.windowTitle===spec.title);
 const lastRead=reads.at(-1);
 const add=(step:number,ids:string[])=>{if(task.steps[step-1]?.status!=='completed'||task.steps[step-1]?.evidence!=='tool_result')updates.push({step,status:'completed',evidenceCallIds:ids});};
 if(lastRead)add(1,[lastRead.callId]);
 // Unknown effects stay uncertain. A new observation is not a write receipt.
 if(task.operations.some(o=>o.status==='unknown'))return updates;
 const write=desktopWrite(task,spec);if(!write)return updates;
 const evidence=write.desktopEvidence!;
 const before=reads.findLast(o=>sameDesktopField(o.desktopEvidence!,evidence)&&o.desktopEvidence!.valueHash===evidence.beforeHash);
 if(!before)return updates;
 add(2,[before.callId,write.callId]);
 const fresh=write.runId===task.activeRunId?write:reads.findLast(o=>o.runId===task.activeRunId&&sameDesktopField(o.desktopEvidence!,evidence)&&o.desktopEvidence!.valueHash===evidence.valueHash);
 if(fresh)add(3,[write.callId,fresh.callId].filter((id,i,a)=>a.indexOf(id)===i));
 return updates;
}
