import type {AttentionItem,AttentionSnapshot,SessionSummary} from '../../../shared/ipc.js';
export const attentionTaskAnchor=(taskId:string):string=>`task-${encodeURIComponent(taskId)}`;
export function attentionTasksForSession(snapshot:AttentionSnapshot|null,sessionId:string):AttentionItem[]{return snapshot?.items.filter(item=>item.sessionId===sessionId)??[];}
/** RAM-only live chats can have attention before their first saved session summary. Display metadata only. */
export function attentionSessionGroups(snapshot:AttentionSnapshot|null,summaries:readonly SessionSummary[]):SessionSummary[]{
 const groups=new Map(summaries.map(summary=>[summary.id,summary]));
 for(const item of snapshot?.items??[])if(!groups.has(item.sessionId))groups.set(item.sessionId,{id:item.sessionId,title:item.sessionTitle,updatedAt:item.updatedAt,runs:0,...(item.projectId?{projectId:item.projectId}:{})});
 return [...groups.values()];
}
export function attentionNavigationBlocked(item:AttentionItem,running:boolean,currentSessionId:string):boolean{return running&&item.sessionId!==currentSessionId;}
type Target={sessionId:string;taskId:string;runId:string;revision:number;nonce:number};
type FocusElement={id:string;dataset:{taskId?:string};scrollIntoView(options?:ScrollIntoViewOptions):void;focus(options?:FocusOptions):void};
/** This boundary only navigates. Latest selection and exact DOM task identity are mandatory. */
export function focusAttentionTarget(target:Target,context:{sessionId:string;taskId:string;runId:string;current:Target|null},element:FocusElement|null):boolean{
 const now=context.current;
 if(!element||!now||context.sessionId!==target.sessionId||context.taskId!==target.taskId||context.runId!==target.runId||now.nonce!==target.nonce||now.sessionId!==target.sessionId||now.taskId!==target.taskId||now.runId!==target.runId||now.revision!==target.revision||element.id!==attentionTaskAnchor(target.taskId)||element.dataset.taskId!==target.taskId)return false;
 element.scrollIntoView({block:'center',behavior:'auto'});element.focus({preventScroll:true});return true;
}
