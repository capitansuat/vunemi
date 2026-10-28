import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { tasksFromEvents } from '@vunemi/agent-core';
import { TaskSummary } from '../../src/renderer/src/components/TaskSummary.js';
import { RecoveryActions } from '../../src/renderer/src/components/RecoveryActions.js';
import { useStore } from '../../src/renderer/src/store.js';
import { copyAnswer } from '../../src/renderer/src/lib/coordinated-design.js';
vi.mock('../../src/renderer/src/store.js', async (load) => { const actual = await load<typeof import('../../src/renderer/src/store.js')>(); const hook = Object.assign((selector?: (state: ReturnType<typeof actual.useStore.getState>) => unknown) => selector ? selector(actual.useStore.getState()) : actual.useStore.getState(), actual.useStore); return {...actual, useStore: hook}; });
vi.hoisted(() => vi.stubGlobal('localStorage', {getItem:()=>null,setItem:()=>{}}));
it('clipboard failure propagates rather than reporting copied', async()=>{
 await expect(copyAnswer('answer',{writeText:async()=>{throw new Error('denied')}})).rejects.toThrow('denied');
});
it('copies the exact answer',async()=>{const writeText=vi.fn();await copyAnswer(' exact\nanswer ',{writeText});expect(writeText).toHaveBeenCalledWith(' exact\nanswer ')});
it('keeps recovery actions in the visible task surface',()=>{
 useStore.setState({running:false,model:null,sessions:{current:'s',sessions:[{id:'s',title:'test',runs:1,updatedAt:1,interrupted:{steps:1,at:1}}],projects:[]}});
 const task=tasksFromEvents([{type:'run.started',runId:'r',goal:'test',model:'local',at:1},{type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['work']}}])[0]!;
 const html=renderToStaticMarkup(<TaskSummary task={task} recovery />);
 expect(html).toContain('data-recovery-actions');
 expect(html).toContain('disabled');
});
it('does not show recovery controls while running',()=>{useStore.setState({running:true});expect(renderToStaticMarkup(<RecoveryActions/>)).toBe('')});
it('renders only observed desktop identity and no invented target',()=>{
 const task=tasksFromEvents([{type:'run.started',runId:'r',goal:'test',model:'local',at:1},{type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['work']}}])[0]!;
 task.operations.push({runId:'r',callId:'c',tool:'desktop_background_append_text',actionClass:'write-local',status:'completed',desktopEvidence:{version:1,kind:'verified-append',bundleId:'com.apple.TextEdit',processStartedAt:1,windowId:5,windowTitle:'Observed.txt',fieldRef:1,valueHash:'a'.repeat(64)}});
 const html=renderToStaticMarkup(<TaskSummary task={task}/>);
 expect(html).toContain('Observed.txt');expect(html).toContain('com.apple.TextEdit');
 task.operations=[];expect(renderToStaticMarkup(<TaskSummary task={task}/>)).not.toContain('Observed.txt');
});
it('shows resume and dismiss labels once within a stopped task', async()=>{
 const { Turn }=await import('../../src/renderer/src/components/Turn.js');
 const { foldEvent }=await import('../../src/renderer/src/lib/fold.js');
 const { t }=await import('@vunemi/i18n');
 const events=[{type:'run.started',runId:'r',goal:'test',model:'local',at:1},{type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['work']}},{type:'run.finished',runId:'r',status:'stopped',detail:'Stopped',at:2}] as import('@vunemi/agent-core').AgentEvent[];
 useStore.setState({running:false,model:null,sessions:{current:'s',sessions:[{id:'s',title:'test',runs:1,updatedAt:1,interrupted:{steps:1,at:1}}],projects:[]}});
 const run=events.reduce(foldEvent, [] as import('../../src/renderer/src/lib/fold.js').RunView[])[0]!;
 const html=renderToStaticMarkup(<Turn run={run} task={tasksFromEvents(events)[0]} recovery/>);
 expect(html.split(t('app.recovery.resume')).length-1).toBe(1);
 expect(html.split(t('app.recovery.dismiss')).length-1).toBe(1);
 expect(html).toContain('<details');
});
it('places live approval after task content exactly once', async()=>{
 const {Turn}=await import('../../src/renderer/src/components/Turn.js');
 const {foldEvent}=await import('../../src/renderer/src/lib/fold.js');
 const events:import('@vunemi/agent-core').AgentEvent[]=[
 {type:'run.started',runId:'r',goal:'test',model:'local',at:1},
 {type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['work']}},
 {type:'step.started',runId:'r',stepId:'s',index:0,at:2},
 {type:'message.delta',runId:'r',stepId:'s',text:'Keep narration'},
 {type:'tool.proposed',runId:'r',stepId:'s',callId:'c',tool:'file_write',actionClass:'write-local',args:{path:'/tmp/report.txt',text:'hello'}},
 {type:'approval.required',requestId:'fresh-approval.required',runId:'r',stepId:'s',callId:'c',tool:'file_write',actionClass:'write-local',args:{path:'/tmp/report.txt',text:'hello'},reason:'Approval marker'}];
 const run=events.reduce(foldEvent,[] as import('../../src/renderer/src/lib/fold.js').RunView[])[0]!;
 const html=renderToStaticMarkup(<Turn run={run} task={tasksFromEvents(events)[0]} active/>);
 expect(html).toContain('data-turn-actions');
 expect(html.split('>Onayla</button>').length-1).toBe(1);
 expect(html).toContain('Keep narration');
 expect(html.indexOf('data-turn-actions')).toBeLessThan(html.indexOf('>Onayla</button>'));
});
it('integrates handoff and choices while retaining failed results and ordinary chat controls',async()=>{
 const {Turn}=await import('../../src/renderer/src/components/Turn.js');
 const {foldEvent}=await import('../../src/renderer/src/lib/fold.js');
 const events:import('@vunemi/agent-core').AgentEvent[]=[
 {type:'run.started',runId:'r',goal:'test',model:'local',at:1},
 {type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['work']}},
 {type:'step.started',runId:'r',stepId:'s',index:0,at:2},
 {type:'tool.proposed',runId:'r',stepId:'s',callId:'h',tool:'file_write',actionClass:'write-local',args:{}},
 {type:'handoff.required',requestId:'fresh-handoff.required',runId:'r',callId:'h',reason:'Human handoff marker',at:3},
 {type:'choice.asked',requestId:'fresh-choice.asked',runId:'r',stepId:'s',callId:'choice',card:{kind:'choice',question:'Choose marker',options:['Unique option'],allowOther:true},at:3},
 {type:'tool.proposed',runId:'r',stepId:'s',callId:'error',tool:'file_read',actionClass:'read',args:{}},
 {type:'tool.finished',runId:'r',callId:'error',ok:false,output:'Error marker',durationMs:1}];
 const run=events.reduce(foldEvent,[] as import('../../src/renderer/src/lib/fold.js').RunView[])[0]!;
 const task=tasksFromEvents(events)[0]!;
 const html=renderToStaticMarkup(<Turn run={run} task={task} active/>);
 expect(html.split('Human handoff marker').length-1).toBe(1);
 expect(html.split('>Unique option</button>').length-1).toBe(1);
 expect(html.indexOf('data-turn-actions')).toBeLessThan(html.indexOf('Choose marker'));
 expect(html).toContain('Error marker');
 const ordinary=renderToStaticMarkup(<Turn run={run}/>);
 expect(ordinary).not.toContain('data-turn-actions');
 expect(ordinary).toContain('Human handoff marker');expect(ordinary).toContain('>Unique option</button>');
});
