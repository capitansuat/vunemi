import {it,expect,vi} from 'vitest';
import {VoiceBar} from '../../src/renderer/src/components/VoiceBar.js';
const holder=vi.hoisted(()=>({state:{} as any}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(v:any)=>[v,vi.fn()],useRef:(v:any)=>({current:v})}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((pick?:any)=>pick?pick(holder.state):holder.state,{getState:()=>holder.state})}));
function nodes(n:any):any[]{return !n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];}
function setup(){
 const call={callId:'c',requestId:'p',tool:'test',args:{},actionClass:'read',status:'running',handoff:'Synthetic handoff'};
 const run={runId:'r',status:'running',pendingAction:{kind:'handoff',callId:'c'},steps:[{calls:[call]}]};
 holder.state={voice:{state:'off',turn:false,handsFree:false,hold:false},running:true,paused:false,taskApprovalStopped:false,sessions:{current:'s'},activeRun:{sessionId:'s',runId:'r'},runs:[run],resolveHandoff:vi.fn(async()=>true)};
 const trailer=nodes(VoiceBar()).find(n=>typeof n.type==='function'&&n.type.name==='Trailer');
 const buttons=nodes(trailer.type(trailer.props)).filter(n=>n.type==='button');return {run,call,buttons,resolve:holder.state.resolveHandoff};
}
it('voice trailer carries the same backend owner and prevents duplicate clicks',()=>{const f=setup();f.buttons[0].props.onClick();f.buttons[1].props.onClick();expect(f.resolve).toHaveBeenCalledExactlyOnceWith('c','done',{runId:'r',requestId:'p'});});
it('captured voice trailer cannot answer a replacement run or Stop intent',()=>{const f=setup();holder.state.taskApprovalStopped=true;f.buttons[0].props.onClick();holder.state.taskApprovalStopped=false;holder.state.activeRun.runId='new';f.run.runId='new';f.buttons[0].props.onClick();expect(f.resolve).not.toHaveBeenCalled();});
