import {singleOfficeEditWorkflow} from './office-progress.js';
import { explicitWriteTargets } from './file-target.js';
import type { TaskRecord, TaskProgressInput } from './tasks.js';

export interface FileStepBindings { sources: string[]; outputs: {path:string;step:number}[]; verificationSteps?:{step:number;paths:string[]}[]; singleEdit?:boolean }
/** Only the application's exact, bounded file-plan template is unambiguous.
 * Edited/model-authored plans keep ordinary explicit progress tracking. */
export function automaticFileBindings(goal:string,task:TaskRecord,resolve:(path:string)=>string):FileStepBindings|null {
 if(!task.planAccepted)return null;
 const edit=singleOfficeEditWorkflow(goal);
 if(edit&&task.steps.length===2&&task.steps.every((step,i)=>step.title===edit.steps[i]))return {sources:[resolve(edit.path)],outputs:[{path:resolve(edit.path),step:2}],singleEdit:true};
 // Older interrupted tasks have no path-bound write evidence. Preserve their
 // existing explicit recovery rather than guess which operation made a file.
 if(task.operations.some(o=>o.status==='completed'&&o.tool==='files_write'&&!o.fileEvidence))return null;
 const outputs=[...new Set(explicitWriteTargets(goal).map(resolve))];
 if(outputs.length<2||outputs.length>6||outputs.some(p=>! /\.(txt|md|csv|json|html|svg|docx|xlsx|pptx)$/i.test(p)))return null;
 const sources=[...new Set([...goal.replace(/[“"][^”"]*[”"]/gu,'').matchAll(/(?:^|\s)((?:\/|~\/)[^\s“"]+)\s+dosyasını\s+oku/giu)].map(m=>resolve(m[1]!)))];
 if(sources.some(p=>outputs.includes(p)))return null;
 const known=new Set([...outputs,...sources]);
 const mentioned=[...goal.replace(/[“"][^”"]*[”"]/gu,'').matchAll(/(?:^|\s)((?:\/|~\/)[^\s“"]+)/gu)].map(m=>resolve(m[1]!));
 if(mentioned.some(path=>!known.has(path)))return null;
 const basenames=outputs.map(p=>p.split('/').at(-1)!);
 const names=outputs.map((p,i)=>basenames.filter(n=>n===basenames[i]).length>1?p.split('/').slice(-2).join('/'):basenames[i]!);
 const titles=[...(sources.length?['Kaynak dosyalarını oku.']:[]),...names.map(n=>`${n}: istenen içeriği oluştur ve doğrula.`)];
 if(titles.length!==task.steps.length||titles.some((title,i)=>title!==task.steps[i]!.title)){
  if(!outputs.every(p=>/\.(docx|xlsx|pptx)$/i.test(p))||new Set(basenames).size!==outputs.length||sources.length)return null;
  const creation=new Map<string,number>(),verificationSteps:{step:number;paths:string[]}[]=[];
  for(const [i,step] of task.steps.entries()){
   const found=outputs.filter((p,j)=>step.title.includes(basenames[j]!));
   if(!found.length)return null;
   if(/doğrula|dogrula|verify|check|kontrol/iu.test(step.title)){verificationSteps.push({step:i+1,paths:found});continue;}
   if(found.length!==1||creation.has(found[0]!)||!/yaz|oluştur|olustur|create|make|write/iu.test(step.title))return null;
   creation.set(found[0]!,i+1);
  }
  if(creation.size!==outputs.length)return null;
  return {sources,outputs:outputs.map(path=>({path,step:creation.get(path)!})),verificationSteps};
 }
 return {sources,outputs:outputs.map((path,i)=>({path,step:i+1+(sources.length?1:0)}))};
}

/** Uses persisted successful receipts, never model prose or an approval.
 * Output verification must follow the latest write/edit, including on resume. */
export function automaticFileCompletions(task:TaskRecord,bindings:FileStepBindings):TaskProgressInput[] {
 const operations=task.operations;
 const sourceReads=bindings.sources.map(path=>operations.findLast(o=>o.status==='completed'&&o.fileEvidence?.kind==='source-read'&&o.fileEvidence.path===path));
 const sourceReady=sourceReads.every(Boolean);
 const updates:TaskProgressInput[]=[];
 if(bindings.sources.length&&sourceReady&&(task.steps[0]?.status!=='completed'||task.steps[0]?.evidence!=='tool_result'))updates.push({step:1,status:'completed',evidenceCallIds:sourceReads.map(o=>o!.callId)});
 if(!sourceReady)return updates;
 for(const output of bindings.outputs){
  const step=task.steps[output.step-1]!;if(step.status==='completed'&&step.evidence==='tool_result')continue;
  const writes=operations.filter(o=>o.status==='completed'&&o.fileEvidence?.kind==='write'&&(o.fileEvidence.path===output.path||o.fileEvidence.paths?.includes(output.path)));
  const write=writes.at(-1);if(!write)continue;
  const after=operations.slice(operations.indexOf(write)+1);
  const verified=after.findLast(o=>o.status==='completed'&&o.runId===task.activeRunId&&o.fileEvidence?.kind==='verified-read'&&(o.fileEvidence.path===output.path||o.fileEvidence.paths?.includes(output.path)));
  if(verified)updates.push({step:output.step,status:'completed',evidenceCallIds:[...writes.map(o=>o.callId),verified.callId]});
 }
 for(const binding of bindings.verificationSteps??[]){
  const step=task.steps[binding.step-1]!;if(step.status==='completed'&&step.evidence==='tool_result')continue;
  const receipts=binding.paths.map(path=>{const write=operations.findLastIndex(o=>o.status==='completed'&&o.fileEvidence?.kind==='write'&&(o.fileEvidence.path===path||o.fileEvidence.paths?.includes(path)));return write<0?undefined:operations.slice(write+1).findLast(o=>o.runId===task.activeRunId&&o.status==='completed'&&o.fileEvidence?.kind==='verified-read'&&o.fileEvidence.path===path);});
  if(receipts.every(Boolean))updates.push({step:binding.step,status:'completed',evidenceCallIds:receipts.map(o=>o!.callId)});
 }
 return updates;
}
