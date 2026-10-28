import {expect,it,vi} from 'vitest';
import {attentionTaskAnchor,attentionTasksForSession,attentionNavigationBlocked,focusAttentionTarget} from '../../src/renderer/src/lib/task-attention.js';
import type {AttentionItem} from '../../src/shared/ipc.js';
const item=(taskId:string,sessionId='chat'):AttentionItem=>({sessionId,taskId,runId:'run-'+taskId,status:'needs_review',reason:'review',title:'Same title',sessionTitle:'Chat',updatedAt:1});
it('retains separate exact task identities within one chat and ignores another chat',()=>{
 const rows=[item('first'),item('second'),item('other','other-chat')];expect(attentionTasksForSession({revision:1,items:rows,truncated:false},'chat').map(i=>i.taskId)).toEqual(['first','second']);
 expect(attentionTaskAnchor('unsafe /task#Ω')).not.toContain('/');expect(attentionTaskAnchor('first')).not.toBe(attentionTaskAnchor('second'));
});
it('preserves cross-chat running restrictions but permits current-chat discovery',()=>{
 expect(attentionNavigationBlocked(item('a'),true,'chat')).toBe(false);expect(attentionNavigationBlocked(item('a','elsewhere'),true,'chat')).toBe(true);expect(attentionNavigationBlocked(item('a','elsewhere'),false,'chat')).toBe(false);
});
it('focuses only an exact current user-selected target without any action callback',()=>{
 const target={sessionId:'chat',taskId:'first',runId:'run-first',revision:3,nonce:7};
 const element={id:attentionTaskAnchor('first'),dataset:{taskId:'first'},scrollIntoView:vi.fn(),focus:vi.fn()};
 expect(focusAttentionTarget(target,{sessionId:'chat',taskId:'first',runId:'run-first',current:target},element)).toBe(true);expect(element.scrollIntoView).toHaveBeenCalledOnce();expect(element.focus).toHaveBeenCalledWith({preventScroll:true});
});
it.each(['session','task','run','nonce','element'] as const)('does not steal focus after %s drift',mode=>{
 const target={sessionId:'chat',taskId:'first',runId:'run-first',revision:3,nonce:7},context={sessionId:'chat',taskId:'first',runId:'run-first',current:{...target}},element={id:attentionTaskAnchor('first'),dataset:{taskId:'first'},scrollIntoView:vi.fn(),focus:vi.fn()};
 if(mode==='session')context.sessionId='other';if(mode==='task')context.taskId='other';if(mode==='run')context.runId='other';if(mode==='nonce')context.current.nonce=8;if(mode==='element')element.dataset.taskId='other';
 expect(focusAttentionTarget(target,context,element)).toBe(false);expect(element.focus).not.toHaveBeenCalled();expect(element.scrollIntoView).not.toHaveBeenCalled();
});
