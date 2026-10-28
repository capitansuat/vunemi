import {expect,it,vi} from 'vitest';
import {selectedQuoteText,quoteSourceCurrent,stageQuote,quoteSourceAnchor} from '../../src/renderer/src/lib/selection-followup.js';
import {ComposerDrafts} from '../../src/renderer/src/lib/composer-drafts.js';
const source={sessionId:'s',runId:'r',stepId:'p',raw:'A literal **bold** answer.'};
const state=()=>({sessions:{current:'s'},runs:[{runId:'r',status:'done',steps:[{stepId:'p',text:source.raw}]}]});
it('accepts one exact source selection and rejects transformed, long, or foreign endpoints',()=>{
 const inside={},outside={},root={contains:(node:unknown)=>node===inside};
 const selected=(text:string,anchor=inside,focus=inside)=>({rangeCount:1,isCollapsed:false,anchorNode:anchor,focusNode:focus,toString:()=>text});
 expect(selectedQuoteText(root as any,selected('literal') as any,source.raw)).toEqual({text:'literal'});
 expect(selectedQuoteText(root as any,selected('bold answer') as any,source.raw)).toEqual({error:'unsupported'});
 expect(selectedQuoteText(root as any,selected('literal',inside,outside) as any,source.raw)).toBeNull();
 expect(selectedQuoteText(root as any,selected('x'.repeat(2001)) as any,'x'.repeat(2001))).toEqual({error:'tooLong'});
});
it('requires same session, completed final step, and unchanged raw source',()=>{
 expect(quoteSourceCurrent(source,state())).toBe(true);
 for(const changed of [{...state(),sessions:{current:'other'}},{...state(),runs:[{...state().runs[0]!,status:'running'}]},{...state(),runs:[{...state().runs[0]!,steps:[{stepId:'p',text:'changed'}]}]},{...state(),runs:[{...state().runs[0]!,steps:[...state().runs[0]!.steps,{stepId:'later',text:'later'}]}]}])expect(quoteSourceCurrent(source,changed)).toBe(false);
});
it('stages only an unchanged source, preserves all draft fields and never calls send',async()=>{
 const drafts=new ComposerDrafts(),send=vi.fn();drafts.change('s','text','My question');drafts.change('s','files',['/tmp/fixture']);const current=state();
 expect(await stageQuote(source,'literal',()=>current,drafts)).toBe(true);
 expect(drafts.read('s')).toMatchObject({text:'My question',files:['/tmp/fixture'],quote:{version:1,sessionId:'s',runId:'r',stepId:'p',text:'literal',sourceHash:expect.stringMatching(/^[a-f0-9]{64}$/)}});expect(send).not.toHaveBeenCalled();
 current.sessions.current='other';expect(await stageQuote(source,'answer',()=>current,drafts)).toBe(false);expect(drafts.read('other').quote).toBeUndefined();
});
it('checks source ownership again after an asynchronous hash',async()=>{
 const drafts=new ComposerDrafts(),current=state();let finish!:(hash:string)=>void;
 const pending=stageQuote(source,'literal',()=>current,drafts,()=>new Promise(resolve=>finish=resolve));current.sessions.current='other';finish('a'.repeat(64));
 expect(await pending).toBe(false);expect(drafts.read('s').quote).toBeUndefined();expect(quoteSourceAnchor('r','p')).toBe(quoteSourceAnchor('r','p'));
});

it('source anchors do not collide when identifiers contain separators',()=>{expect(quoteSourceAnchor('a-b','c')).not.toBe(quoteSourceAnchor('a','b-c'));});

it('delayed hashing cannot replace a newer quote selected while it was pending',async()=>{const drafts=new ComposerDrafts(),current=state();let finish!:(hash:string)=>void;const pending=stageQuote(source,'literal',()=>current,drafts,()=>new Promise(resolve=>finish=resolve));const newer={version:1 as const,sessionId:'s',runId:'r',stepId:'p',text:'answer',sourceHash:'b'.repeat(64)};drafts.change('s','quote',newer);finish('a'.repeat(64));expect(await pending).toBe(false);expect(drafts.read('s').quote).toEqual(newer);});
