import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '@vunemi/i18n';
import {tasksFromEvents} from '@vunemi/agent-core';
import {SessionsNav,AttentionTaskRow} from '../../src/renderer/src/components/SessionsNav.js';
import {TaskSummary} from '../../src/renderer/src/components/TaskSummary.js';
import {Turn} from '../../src/renderer/src/components/Turn.js';
import {attentionTaskAnchor} from '../../src/renderer/src/lib/task-attention.js';
const holder=vi.hoisted(()=>({state:{} as any,filter:'attention',effects:[] as Array<()=>unknown>}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>[initial==='all'?holder.filter:typeof initial==='function'?initial():initial,vi.fn()],useEffect:(effect:()=>unknown)=>{holder.effects.push(effect);}}));
vi.mock('zustand/react/shallow',()=>({useShallow:(selector:any)=>selector}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((selector:any)=>selector?selector(holder.state):holder.state,{getState:()=>holder.state})}));
const item=(taskId:string,sessionId='chat')=>({sessionId,taskId,runId:'run-'+taskId,status:'needs_review',reason:'review' as const,title:'Task '+taskId,sessionTitle:'A conversation',updatedAt:1000});
beforeEach(()=>{setLocale('en');holder.filter='attention';holder.effects=[];holder.state={locale:'en',running:false,sessions:{current:'chat',sessions:[{id:'chat',title:'A conversation',updatedAt:1,runs:3},{id:'other',title:'Other conversation',updatedAt:1,runs:1}],projects:[]},attention:{revision:1,items:[item('a'),item('b')],truncated:false},attentionLoading:false,attentionError:null,attentionTarget:null,refreshAttention:vi.fn(async()=>{}),openAttentionTask:vi.fn(async()=>{}),addProject:vi.fn(),artefacts:[],taskPermissions:null,nativeRecipes:null};});
function nodes(node:any):any[]{return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
it('shows task count and separate task rows beyond interrupted sessions',()=>{
 const html=renderToStaticMarkup(<SessionsNav/>);expect(html).toContain('Needs attention (2)');expect(html).toContain('Task a');expect(html).toContain('Task b');expect(html).not.toContain('Other conversation');expect(html).toContain('Review needed');expect(html).not.toContain('{title}');
});
it('shows and opens current unsaved live tasks without fabricating saved session state',()=>{
 holder.state.sessions.sessions=[];holder.state.attention.items=[{...item('live'),status:'waiting_approval',reason:'approval'}];
 const html=renderToStaticMarkup(<SessionsNav/>);expect(html).toContain('Task live');expect(html).toContain('Approval needed');expect(html).toContain('A conversation');expect(holder.state.sessions.sessions).toEqual([]);
 const button=nodes(AttentionTaskRow({item:holder.state.attention.items[0]})).find(node=>node.type==='button')!;button.props.onClick();expect(holder.state.openAttentionTask).toHaveBeenCalledExactlyOnceWith(holder.state.attention.items[0]);
});
it('distinguishes loading, successful empty, stale error and truncated snapshots',()=>{
 holder.state.attention=null;holder.state.attentionLoading=true;let html=renderToStaticMarkup(<SessionsNav/>);expect(html).toContain('Loading tasks');expect(html).not.toContain('No tasks need attention');
 holder.state.attentionLoading=false;holder.state.attention={revision:2,items:[],truncated:false};html=renderToStaticMarkup(<SessionsNav/>);expect(html).toContain('No tasks need attention');
 holder.state.attention={revision:3,items:[item('retained')],truncated:true};holder.state.attentionError='Synthetic refresh failed';html=renderToStaticMarkup(<SessionsNav/>);expect(html).toContain('Task retained');expect(html).toContain('Synthetic refresh failed');expect(html).toContain('(1+)');expect(html).toContain('Showing the latest 100 tasks');
});
it('navigation clicks carry the exact task item and never make an approval/resume call',()=>{
 const target=item('exact');const tree=AttentionTaskRow({item:target});const button=nodes(tree).find(n=>n.type==='button')!;button.props.onClick();expect(holder.state.openAttentionTask).toHaveBeenCalledExactlyOnceWith(target);
 expect(Object.keys(holder.state).filter(key=>/approve|resume|decide/i.test(key))).toEqual([]);
});
it('rechecks running state at click and permits only same-chat task navigation',()=>{
 const target=item('elsewhere','other'),tree=AttentionTaskRow({item:target}),button=nodes(tree).find(n=>n.type==='button')!;holder.state.running=true;button.props.onClick();expect(holder.state.openAttentionTask).not.toHaveBeenCalled();
 const blockedHtml=renderToStaticMarkup(<AttentionTaskRow item={target}/>);expect(blockedHtml).toContain('disabled');expect(blockedHtml).toContain('Finish or stop the current task');
 nodes(AttentionTaskRow({item:item('current')})).find(n=>n.type==='button')!.props.onClick();expect(holder.state.openAttentionTask).toHaveBeenCalledOnce();
});
it('keeps a safe exact focus anchor when a waiting plan hides the task summary',()=>{
 const task=tasksFromEvents([{type:'run.started',runId:'run-a',goal:'Plan review task',model:'m',at:1},{type:'plan.proposed',runId:'run-a',steps:['Read'],at:2}])[0]!;
 const html=renderToStaticMarkup(<TaskSummary task={task}/>);expect(html).toContain(`id="${attentionTaskAnchor(task.id)}"`);expect(html).toContain(`data-task-id="${task.id}"`);expect(html).toContain('tabindex="-1"');
});
it('Turn schedules focus only for an explicit matching target and rejects a later replacement',()=>{
 const task=tasksFromEvents([{type:'run.started',runId:'run-a',goal:'Task',model:'m',at:1}])[0]!;
 const run={runId:'run-a',goal:'Task',model:'m',status:'running',startedAt:1,steps:[]};
 const invoke=()=>((Turn as any).type)({run,task});
 const callbacks:Array<()=>void>=[];vi.stubGlobal('requestAnimationFrame',vi.fn((cb:()=>void)=>{callbacks.push(cb);return callbacks.length;}));vi.stubGlobal('cancelAnimationFrame',vi.fn());
 const element={id:attentionTaskAnchor(task.id),dataset:{taskId:task.id},scrollIntoView:vi.fn(),focus:vi.fn()};vi.stubGlobal('document',{getElementById:vi.fn(()=>element)});
 invoke();holder.effects.pop()!();expect(callbacks).toHaveLength(0);
 holder.state.attentionTarget={sessionId:'chat',taskId:task.id,runId:'run-a',revision:1,nonce:1};invoke();holder.effects.pop()!();expect(callbacks).toHaveLength(1);
 holder.state.attentionTarget={...holder.state.attentionTarget,nonce:2};callbacks[0]!();expect(element.focus).not.toHaveBeenCalled();
 invoke();holder.effects.pop()!();callbacks[1]!();expect(element.focus).toHaveBeenCalledOnce();expect(holder.state.openAttentionTask).not.toHaveBeenCalled();
});
it('waiting-plan attention focuses the visible decision at the end of the turn',()=>{
 const events:any[]=[{type:'run.started',runId:'plan-run',goal:'Plan review task',model:'m',at:1},{type:'plan.proposed',runId:'plan-run',steps:['Read'],requestId:'plan-owner',at:2}];
 const task=tasksFromEvents(events)[0]!,plan={steps:['Read'],status:'awaiting' as const,requestId:'plan-owner'};
 const run:any={runId:'plan-run',goal:'Plan review task',model:'m',status:'running',startedAt:1,steps:[],plan,pendingAction:{kind:'plan',requestId:'plan-owner'}};
 holder.state.running=true;holder.state.activeRun={sessionId:'chat',runId:'plan-run'};holder.state.runs=[run];
 const html=renderToStaticMarkup(<Turn run={run} task={task} active/>),id=`id="${attentionTaskAnchor(task.id)}"`,at=html.indexOf(id);
 expect(at).toBeGreaterThan(0);expect(html.slice(html.lastIndexOf('<div',at),at)).toContain('data-turn-actions');expect(html.split(id).length).toBe(2);
});
it('Turn renders escaped quoted-source attribution and only the final completed answer offers selection',()=>{
 const source={version:1 as const,sessionId:'chat',runId:'old-run',stepId:'old-step',text:'<img src=x onerror=attack()>',sourceHash:'a'.repeat(64)};
 const run={runId:'answer-run',goal:'Explain this',model:'m',status:'done' as const,startedAt:1,finishedAt:2,quotedSource:source,steps:[{stepId:'answer-step',index:0,startedAt:1,text:'Final answer',thought:'',calls:[],choices:[],files:[]}]};
 const html=renderToStaticMarkup(<Turn run={run as any}/>);expect(html).toContain('&lt;img src=x onerror=attack()&gt;');expect(html).not.toContain('<img src=x');expect(html).toContain('quote-source-');
 const root=((Turn as any).type)({run});const step=nodes(root).find(n=>n.props?.step?.stepId==='answer-step');expect(step.props.quoteOrigin).toMatchObject({sessionId:'chat',runId:'answer-run',stepId:'answer-step',raw:'Final answer'});
 const live=((Turn as any).type)({run:{...run,status:'running'}});expect(nodes(live).find(n=>n.props?.step?.stepId==='answer-step').props.quoteOrigin).toBeUndefined();
});
