// VUN-16 cross-chat running protection. The real renderer store drives
// AttentionTaskRow and Turn; components are called directly with a small
// hook harness, so no DOM or live app is involved.
import {beforeEach,expect,it,vi} from 'vitest';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));
import {setLocale,t} from '@vunemi/i18n';
import {tasksFromEvents} from '@vunemi/agent-core';
import {useStore} from '../../src/renderer/src/store.js';
import {AttentionTaskRow} from '../../src/renderer/src/components/SessionsNav.js';
import {Turn} from '../../src/renderer/src/components/Turn.js';
import {composerDrafts} from '../../src/renderer/src/lib/composer-drafts.js';
import {attentionTaskAnchor} from '../../src/renderer/src/lib/task-attention.js';
const holder=vi.hoisted(()=>({hooks:[] as any[],index:0,effects:[] as Array<()=>unknown>}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>{const i=holder.index++;if(!(i in holder.hooks))holder.hooks[i]=typeof initial==='function'?initial():initial;return[holder.hooks[i],(next:any)=>{holder.hooks[i]=typeof next==='function'?next(holder.hooks[i]):next;}];},useEffect:(effect:()=>unknown)=>{holder.effects.push(effect);}}));
vi.mock('zustand/react/shallow',()=>({useShallow:(selector:any)=>selector}));
// Components read the actual store state; only React's subscription hook is bypassed.
vi.mock('../../src/renderer/src/store.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/renderer/src/store.js')>();const real=actual.useStore;return{...actual,useStore:Object.assign((pick?:any)=>pick?pick(real.getState()):real.getState(),{getState:real.getState,setState:real.setState,subscribe:real.subscribe})};});
function nodes(node:any):any[]{return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
const text=(node:any)=>nodes(node).flatMap(n=>[n.props?.children].flat(Infinity)).filter(c=>typeof c==='string').join(' ');
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const runEvents=[{type:'run.started',runId:'run-live',goal:'Synthetic running task',model:'m',at:1}] as any[];
const otherEvents=[{type:'run.started',runId:'run-other',goal:'Synthetic other task',model:'m',at:1}] as any[];
const liveTask=tasksFromEvents(runEvents)[0]!,otherTask=tasksFromEvents(otherEvents)[0]!;
const row=(sessionId:string,taskId:string,runId:string)=>({sessionId,taskId,runId,status:'needs_review',reason:'review' as const,title:'Synthetic '+taskId,sessionTitle:'Synthetic '+sessionId,updatedAt:1});
const other=row('s-other',otherTask.id,'run-other'),same=row('s-run',liveTask.id,'run-live');
let api:Record<string,ReturnType<typeof vi.fn>>;
beforeEach(()=>{
 setLocale('en');holder.hooks=[];holder.index=0;holder.effects=[];
 api={openAttentionTask:vi.fn(),listAttention:vi.fn(async()=>useStore.getState().attention),openSession:vi.fn(),stopRun:vi.fn(),send:vi.fn(),steer:vi.fn(),resolveApproval:vi.fn(),resolveHandoff:vi.fn(),resolvePlan:vi.fn(),resolveChoice:vi.fn(),resolveTaskApproval:vi.fn(),resumeInterrupted:vi.fn(),setPolicy:vi.fn(),interruptQueued:vi.fn(),clearQueue:vi.fn()};
 vi.stubGlobal('window',{vunemi:api});
 const liveRun={runId:'run-live',goal:'Synthetic running task',model:'m',status:'running',startedAt:1,steps:[]};
 useStore.setState({view:'chat',running:true,paused:false,sessions:{current:'s-run',sessions:[{id:'s-run',title:'Synthetic s-run',updatedAt:1,runs:1},{id:'s-other',title:'Synthetic s-other',updatedAt:1,runs:1}],projects:[]},
  activeRun:{sessionId:'s-run',runId:'run-live'},runs:[liveRun] as any,tasks:[liveTask],queue:[{id:'q1',text:'Queued synthetic follow-up'}] as any,pendingStart:null,
  attention:{revision:5,items:[other,same],truncated:false},attentionTarget:null,attentionError:null,attentionLoading:false});
 composerDrafts.change('s-run','text','Half-written synthetic draft');composerDrafts.change('s-run','files',['/fixture/attachment.txt']);
});
function snapshot(){const s=useStore.getState();return{view:s.view,running:s.running,sessions:s.sessions,activeRun:s.activeRun,runs:s.runs,tasks:s.tasks,queue:s.queue,pendingStart:s.pendingStart,attentionTarget:s.attentionTarget,draft:composerDrafts.read('s-run'),otherDraft:composerDrafts.read('s-other')};}
const draw=(item:any)=>{holder.index=0;return AttentionTaskRow({item});};
const button=(tree:any)=>nodes(tree).find(n=>n.type==='button')!;
/** HTML activation behaviour of a native <button>: Enter on keydown, Space on keyup, nothing when disabled or a key handler intervenes. */
function activate(el:any,key:'Enter'|' '){
 if(el.type!=='button'||el.props.disabled)return false;
 const event={key,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
 (key==='Enter'?el.props.onKeyDown:el.props.onKeyUp)?.(event);
 if(event.defaultPrevented)return false;el.props.onClick?.({detail:0});return true;
}

it('while a session runs, a row for another session is disabled with a visible reason and a captured click navigates nowhere',async()=>{
 const before=snapshot(),tree=draw(other),el=button(tree);
 expect(el.props.disabled).toBe(true);expect(text(tree)).toContain(t('taskAttention.blocked'));expect(el.props.title).toBe(t('taskAttention.blocked'));
 el.props.onClick();expect(activate(el,'Enter')).toBe(false);expect(activate(el,' ')).toBe(false);await settle();
 await expect(useStore.getState().openAttentionTask(other)).rejects.toThrow(t('main.stopFirst'));
 for(const fn of Object.values(api))expect(fn).not.toHaveBeenCalled();
 expect(snapshot()).toEqual(before);const after=snapshot();for(const key of Object.keys(before) as (keyof typeof before)[])expect(after[key]).toBe(before[key]);
});
it('a main-side refusal (renderer state lagging) is shown on the row and leaves navigation, draft, queue and attachments untouched',async()=>{
 useStore.setState({running:false});const before=snapshot();
 api.openAttentionTask!.mockRejectedValue(Error(`Error invoking remote method 'attention:open': Error: ${t('main.stopFirst')}`));
 button(draw(other)).props.onClick();await settle();
 expect(api.openAttentionTask).toHaveBeenCalledExactlyOnceWith({sessionId:'s-other',taskId:other.taskId,runId:'run-other',revision:5});
 const tree=draw(other),alert=nodes(tree).find(n=>n.props?.role==='alert');expect(alert).toBeDefined();expect(text(alert)).toBe(t('main.stopFirst'));
 const after=snapshot();for(const key of Object.keys(before) as (keyof typeof before)[])expect(after[key]).toBe(before[key]);
 for(const [name,fn] of Object.entries(api))if(!['openAttentionTask','listAttention'].includes(name))expect(fn).not.toHaveBeenCalled();
});
it('while a session runs, a row in the same session opens the exact task and keeps run, draft, queue and attachments',async()=>{
 const before=snapshot();api.openAttentionTask!.mockImplementation(async(target:any)=>({sessions:useStore.getState().sessions,target}));
 const el=button(draw(same));expect(el.props.disabled).toBe(false);el.props.onClick();await settle();
 expect(api.openAttentionTask).toHaveBeenCalledExactlyOnceWith({sessionId:'s-run',taskId:same.taskId,runId:'run-live',revision:5});
 const after=snapshot();expect(after.attentionTarget).toMatchObject({sessionId:'s-run',taskId:same.taskId,runId:'run-live',revision:5});
 for(const key of ['running','sessions','activeRun','runs','tasks','queue','pendingStart','draft','otherDraft'] as const)expect(after[key]).toBe(before[key]);
 for(const [name,fn] of Object.entries(api))if(!['openAttentionTask','listAttention'].includes(name))expect(fn).not.toHaveBeenCalled();
});
it.each(['Enter',' '] as const)('keyboard %j on an attention row acts like a click and focus lands on the exact task panel',async key=>{
 api.openAttentionTask!.mockImplementation(async(target:any)=>({sessions:useStore.getState().sessions,target}));
 const el=button(draw(same));
 expect(el.props.type).toBe('button');expect(el.props.onKeyDown).toBeUndefined();expect(el.props.onKeyUp).toBeUndefined();expect(el.props.tabIndex===undefined||el.props.tabIndex>=0).toBe(true);expect(el.props['aria-label']).toContain(same.title);
 expect(activate(el,key)).toBe(true);await settle();
 expect(api.openAttentionTask).toHaveBeenCalledOnce();const target=useStore.getState().attentionTarget!;expect(target.taskId).toBe(same.taskId);
 const exact={id:attentionTaskAnchor(liveTask.id),dataset:{taskId:liveTask.id},scrollIntoView:vi.fn(),focus:vi.fn()},decoy={id:attentionTaskAnchor('decoy'),dataset:{taskId:'decoy'},scrollIntoView:vi.fn(),focus:vi.fn()};
 const frames:Array<()=>void>=[];vi.stubGlobal('requestAnimationFrame',vi.fn((cb:()=>void)=>frames.push(cb)));vi.stubGlobal('cancelAnimationFrame',vi.fn());
 vi.stubGlobal('document',{getElementById:vi.fn((id:string)=>id===exact.id?exact:id===decoy.id?decoy:null)});
 holder.effects=[];holder.index=0;((Turn as any).type)({run:useStore.getState().runs[0],task:liveTask,active:true});holder.effects.pop()!();
 expect(frames).toHaveLength(1);frames[0]!();
 expect(exact.focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true});expect(decoy.focus).not.toHaveBeenCalled();
 expect(composerDrafts.read('s-run').text).toBe('Half-written synthetic draft');expect(useStore.getState().queue).toHaveLength(1);
});
