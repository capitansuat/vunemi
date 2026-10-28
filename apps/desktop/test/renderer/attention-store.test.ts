import {it,expect,vi,beforeEach} from 'vitest';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));
import {useStore} from '../../src/renderer/src/store.js';
const item={sessionId:'s',taskId:'t',runId:'r',status:'needs_review',reason:'review' as const,title:'Synthetic',sessionTitle:'Synthetic',updatedAt:1};
const snapshot={revision:2,items:[item],truncated:false};
const deferred=()=>{let resolve!:(x:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
beforeEach(()=>{useStore.setState({sessions:{current:'s',sessions:[],projects:[]},running:false,runs:[],tasks:[],attention:snapshot,attentionTarget:null,attentionError:null});vi.stubGlobal('window',{vunemi:{listAttention:vi.fn(async()=>snapshot)}});});
it('same-chat attention navigation preserves running owner, timeline and does not resume or send',async()=>{
 const runs:any[]=[{runId:'r',status:'running',steps:[]}];useStore.setState({running:true,runs,activeRun:{sessionId:'s',runId:'r'}});
 const open=vi.fn(async(target:any)=>({sessions:useStore.getState().sessions,target}));(window.vunemi as any).openAttentionTask=open;
 await useStore.getState().openAttentionTask(item);expect(useStore.getState().runs).toBe(runs);expect(useStore.getState().activeRun).toEqual({sessionId:'s',runId:'r'});expect(useStore.getState().attentionTarget?.taskId).toBe('t');expect(open).toHaveBeenCalledExactlyOnceWith({sessionId:'s',taskId:'t',runId:'r',revision:2});
});
it('a running other chat blocks the request without stopping it',async()=>{useStore.setState({running:true,sessions:{current:'other',sessions:[],projects:[]}});const open=vi.fn();(window.vunemi as any).openAttentionTask=open;await expect(useStore.getState().openAttentionTask(item)).rejects.toThrow();expect(open).not.toHaveBeenCalled();expect(useStore.getState().running).toBe(true);});
it('task submission cannot race an unresolved attention navigation',async()=>{const d=deferred(),send=vi.fn();(window.vunemi as any).openAttentionTask=()=>d.promise;(window.vunemi as any).send=send;const opening=useStore.getState().openAttentionTask(item);await expect(useStore.getState().send('Keep my draft')).rejects.toThrow();expect(send).not.toHaveBeenCalled();d.resolve({sessions:useStore.getState().sessions,target:{sessionId:'s',taskId:'t',runId:'r',revision:2}});await opening;});
it('an older global list cannot overwrite a later snapshot',async()=>{const a=deferred(),b=deferred();(window.vunemi as any).listAttention=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const first=useStore.getState().refreshAttention(),second=useStore.getState().refreshAttention();b.resolve({...snapshot,revision:4});await second;a.resolve(snapshot);await first;expect(useStore.getState().attention?.revision).toBe(4);});
it('a late selection response cannot replace a newer manual session navigation',async()=>{const d=deferred();(window.vunemi as any).openAttentionTask=()=>d.promise;(window.vunemi as any).openSession=async()=>({current:'manual',sessions:[],projects:[],events:[]});(window.vunemi as any).context=async()=>({});useStore.setState({refreshContext:async()=>{}});const opening=useStore.getState().openAttentionTask(item);await useStore.getState().openSession('manual');d.resolve({sessions:{current:'s',sessions:[],projects:[]},target:{sessionId:'s',taskId:'t',runId:'r',revision:2}});await opening;expect(useStore.getState().sessions.current).toBe('manual');expect(useStore.getState().attentionTarget).toBeNull();});
it('a delayed older manual open cannot overwrite newer attention navigation',async()=>{
 const d=deferred();(window.vunemi as any).openSession=()=>d.promise;(window.vunemi as any).openAttentionTask=async(target:any)=>({sessions:useStore.getState().sessions,target});useStore.setState({refreshContext:async()=>{}});
 const old=useStore.getState().openSession('manual');await useStore.getState().openAttentionTask(item);
 d.resolve({current:'manual',sessions:[],projects:[],events:[]});await old;
 expect(useStore.getState().sessions.current).toBe('s');expect(useStore.getState().attentionTarget?.taskId).toBe('t');
});
