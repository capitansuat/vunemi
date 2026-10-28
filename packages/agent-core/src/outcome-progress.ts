import {t} from '@vunemi/i18n';
import type {TaskRecord,TaskProgressInput} from './tasks.js';
import {validOutcomeEvidence,requiresOutcomeEvidence} from './outcome-evidence.js';
export interface OutcomeWorkflow {tool:'page_goto'|'calendar_create'|'mail_draft';target:string;steps:string[];url?:string;title?:string;start?:number;end?:number;to?:string;subject?:string;body?:string}
const url=(s:string)=>{try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const instant=(s:string):number|null=>{
 const parts=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|[+-](\d\d):(\d\d))$/.exec(s);
 if(!parts)return null;
 const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]);
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>(days[month-1]??0)||Number(parts[4])>23||Number(parts[5])>59||Number(parts[6]??0)>59||Number(parts[8]??0)>23||Number(parts[9]??0)>59)return null;
 const value=Date.parse(s);return Number.isFinite(value)?value:null;
};
/** Only complete, single-action forms have application-owned plans. All other prose/edited plans retain explicit progress. */
export function outcomeWorkflow(goal:string):OutcomeWorkflow|null{
 let m=/^(?:Open|Navigate to) (https?:\/\/\S+) and verify (?:the )?(?:page|title)\.?$/iu.exec(goal)||/^(https?:\/\/\S+) sayfasını aç ve başlığını doğrula\.?$/u.exec(goal);
 if(m){const u=url(m[1]!);return u?{tool:'page_goto',target:u,url:u,steps:[t('outcomeProgress.browserWrite',{target:u}),t('outcomeProgress.browserVerify',{target:u})]}:null;}
 m=/^Create (?:a )?calendar event "([^"\n]{1,200})" from (\S+) to (\S+?)[.]?$/u.exec(goal)||/^Takvime "([^"\n]{1,200})" etkinliğini (\S+) ile (\S+?) arasında ekle[.]?$/u.exec(goal);
 if(m){const start=instant(m[2]!),end=instant(m[3]!);return start!==null&&end!==null&&end>start?{tool:'calendar_create',target:m[1]!,title:m[1]!,start,end,steps:[t('outcomeProgress.calendarWrite',{target:m[1]!}),t('outcomeProgress.calendarVerify',{target:m[1]!})]}:null;}
 m=/^Save a draft to ([^\s@]+@[^\s@]+\.[^\s@]+) with subject "([^"\n]{1,200})" and body "([^"]{1,8000})"[.]?$/u.exec(goal)||/^([^\s@]+@[^\s@]+\.[^\s@]+) için konusu "([^"\n]{1,200})", metni "([^"]{1,8000})" olan bir taslak kaydet[.]?$/u.exec(goal);
 return m?{tool:'mail_draft',target:m[2]!,to:m[1]!,subject:m[2]!,body:m[3]!,steps:[t('outcomeProgress.draftWrite',{target:m[2]!}),t('outcomeProgress.draftVerify',{target:m[2]!})]}:null;
}
export function outcomeCallMatches(w:OutcomeWorkflow,tool:string,args:unknown):boolean{
 if(tool!==w.tool||!args||typeof args!=='object'||Array.isArray(args))return false;const a=args as Record<string,unknown>;
 if(w.tool==='page_goto')return typeof a.url==='string'&&url(a.url)===w.url;
 if(w.tool==='calendar_create')return a.title===w.title&&typeof a.start==='string'&&typeof a.end==='string'&&instant(a.start)===w.start&&instant(a.end)===w.end&&(a.allDay===undefined||a.allDay===false)&&['calendar','location','notes'].every(k=>a[k]===undefined||a[k]==='');
 return Array.isArray(a.to)&&a.to.length===1&&typeof a.to[0]==='string'&&a.to[0].toLowerCase()===w.to!.toLowerCase()&&a.subject===w.subject&&a.body===w.body&&(a.cc===undefined||Array.isArray(a.cc)&&!a.cc.length)&&a.inReplyTo===undefined&&a.account===undefined;
}
/** Edited plans and locale changes cannot inherit an application-owned completion binding. */
export function isOutcomeWorkflowPlan(task:TaskRecord):boolean{
 const w=outcomeWorkflow(task.goal);
 return !!w&&task.planAccepted&&task.steps.length===w.steps.length&&task.steps.every((s,i)=>s.title===w.steps[i]);
}
export function automaticOutcomeCompletions(task:TaskRecord):TaskProgressInput[]{
 const w=outcomeWorkflow(task.goal);if(!w||!isOutcomeWorkflowPlan(task)||task.operations.some(o=>o.status==='unknown'||o.status==='completed'&&requiresOutcomeEvidence(o.tool)&&!validOutcomeEvidence(o.outcomeEvidence,o.tool)))return [];
 const proof=task.operations.findLast(o=>o.runId===task.activeRunId&&o.status==='completed'&&o.outcomeBound&&o.tool===w.tool&&validOutcomeEvidence(o.outcomeEvidence,o.tool));if(!proof)return [];
 return task.steps.flatMap((s,i)=>s.status==='completed'&&s.evidence==='tool_result'?[]:[{step:i+1,status:'completed' as const,evidenceCallIds:[proof.callId]}]);
}
