import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AttentionSeen,REVIEW_DAYS,requireAttentionDismissal} from '../../src/main/attention-seen.js';
import {SessionStore} from '../../src/main/sessions.js';
import type {AttentionItem} from '../../src/shared/ipc.js';
let dirs:string[]=[];afterEach(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});dirs=[];});
const temp=()=>{const d=mkdtempSync(join(tmpdir(),'attention-seen-'));dirs.push(d);return d;};
const DAY=86_400_000,NOW=100*DAY;
const item=(over:Partial<AttentionItem>={}):AttentionItem=>({sessionId:'s_fixture',taskId:'t',runId:'r',status:'needs_review',reason:'review',title:'Task',sessionTitle:'Chat',updatedAt:NOW-DAY,...over});
it('drops only reviews past their days; waiting work and uncertain results stay however old',()=>{
 const seen=new AttentionSeen(join(temp(),'seen.json'));
 const old=NOW-(REVIEW_DAYS*DAY+1);
 expect(seen.shown(item(),NOW)).toBe(true);
 expect(seen.shown(item({updatedAt:old}),NOW)).toBe(false);
 for(const reason of ['uncertain','approval','plan','user','recovery'] as const)expect(seen.shown(item({reason,updatedAt:old}),NOW),reason).toBe(true);
});
it('keeps a dismissal across restarts until something happens in the task again',()=>{
 const file=join(temp(),'seen.json');
 const uncertain=item({taskId:'u',reason:'uncertain',status:'interrupted'}),review=item();
 new AttentionSeen(file).dismiss([uncertain],[uncertain,review]);
 const again=new AttentionSeen(file);
 expect(again.shown(uncertain,NOW)).toBe(false);
 expect(again.shown(review,NOW)).toBe(true);
 // The task moved on: it is listed again.
 expect(again.shown({...uncertain,updatedAt:uncertain.updatedAt+1},NOW)).toBe(true);
 // Entries for tasks no longer listed, or changed since, are forgotten.
 again.dismiss([review],[review,{...uncertain,updatedAt:uncertain.updatedAt+1}]);
 expect(JSON.parse(readFileSync(file,'utf8')).seen).toEqual([[`s_fixture\u0000t`,review.updatedAt]]);
});
it('reads a damaged file as nothing dismissed',()=>{
 const file=join(temp(),'seen.json');writeFileSync(file,'{broken');
 expect(new AttentionSeen(file).shown(item(),NOW)).toBe(true);
});
it('accepts only listed tasks, matched on session, task and time',()=>{
 const a=item(),snapshot={revision:1,items:[a],truncated:false};
 expect(requireAttentionDismissal(snapshot,{items:[{sessionId:a.sessionId,taskId:a.taskId,updatedAt:a.updatedAt}]})).toEqual([a]);
 for(const raw of [null,[],{},{items:[]},{items:[a],extra:1},{items:Array(501).fill(a)}])expect(()=>requireAttentionDismissal(snapshot,raw)).toThrow('Invalid');
 expect(()=>requireAttentionDismissal(snapshot,{items:[{...a,updatedAt:a.updatedAt+1}]})).toThrow('no longer');
 expect(()=>requireAttentionDismissal(snapshot,{items:[{...a,taskId:'other'}]})).toThrow('no longer');
});
it('takes a dismissed task off the list without touching the conversation it is in',()=>{
 const d=temp(),sessions=join(d,'sessions');
 const s=new SessionStore(sessions);
 s.record({type:'run.started',runId:'r',goal:'Plan',model:'m',at:1});
 s.record({type:'plan.proposed',runId:'r',steps:['Step'],at:2});
 const seen=new AttentionSeen(join(d,'seen.json'));
 const list=()=>s.attention(i=>seen.shown(i,NOW));
 const before=list();expect(before.items).toHaveLength(1);
 const events=JSON.stringify(s.attentionItems());
 seen.dismiss(requireAttentionDismissal(before,{items:before.items}),s.attentionItems());
 const after=list();
 expect(after.items).toEqual([]);
 expect(after.revision).toBeGreaterThan(before.revision);
 // The task itself still waits: only the list changed.
 expect(JSON.stringify(s.attentionItems())).toBe(events);
});
