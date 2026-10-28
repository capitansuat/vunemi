import {it,expect} from 'vitest';
import {requireAttentionTarget} from '../../src/main/attention-navigation.js';
const target={sessionId:'s',taskId:'t',runId:'r',revision:2};
const snapshot={revision:2,items:[{...target,status:'needs_review',reason:'review' as const,title:'Synthetic',sessionTitle:'Owned',updatedAt:1}],truncated:false};
it('only navigates to an exact member of the current snapshot',()=>{expect(requireAttentionTarget(snapshot,target)).toEqual(target);});
it.each([{...target,revision:1},{...target,taskId:'other'},{...target,sessionId:'other'},{...target,runId:'new'},{...target,approve:true},null])('rejects stale, foreign or decision-shaped navigation input %j',raw=>{expect(()=>requireAttentionTarget(snapshot,raw)).toThrow();});
