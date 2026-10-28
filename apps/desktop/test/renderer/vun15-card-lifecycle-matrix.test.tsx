// VUN-15 remaining card lifecycle variants. Synthetic events only; no live app.
// Each card is folded from real lifecycle events, a handler is captured, the
// lifecycle moves on, and the captured handler must make zero decision calls.
import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale,t} from '@vunemi/i18n';
import type {AgentEvent} from '@vunemi/agent-core';
import {ApprovalCard,HandoffCard,AutomationSetupCard,CallCard} from '../../src/renderer/src/components/CallCard.js';
import {PlanCard} from '../../src/renderer/src/components/PlanCard.js';
import {ChoiceCard} from '../../src/renderer/src/components/ChoiceCard.js';
import {RecoveryActions} from '../../src/renderer/src/components/RecoveryActions.js';
import {foldEvent,activeTurnAction,type RunView} from '../../src/renderer/src/lib/fold.js';
import {callStatusLabel} from '../../src/renderer/src/lib/labels.js';
const holder=vi.hoisted(()=>({state:{} as any,hooks:[] as any[],index:0,effect:false}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>{const i=holder.index++;if(!(i in holder.hooks))holder.hooks[i]=typeof initial==='function'?initial():initial;return[holder.hooks[i],(next:any)=>{holder.hooks[i]=typeof next==='function'?next(holder.hooks[i]):next;}];},useEffect:(fn:()=>void)=>{if(!holder.effect){holder.effect=true;fn();}}}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((pick?:any)=>pick?pick(holder.state):holder.state,{getState:()=>holder.state})}));
function render<T>(fn:()=>T):T{holder.index=0;return fn();}
function nodes(node:any):any[]{if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
const buttons=(node:any)=>nodes(node).filter(n=>n.type==='button');
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
type Kind='approval'|'scoped'|'automation'|'handoff'|'plan'|'choice';
type Change='session-switched'|'run-ended'|'superseded-by-new-call'|'same-call-new-request';
const card={kind:'choice',question:'Synthetic question',options:['A','B']};
const offer=(revision=1)=>({offerId:'offer-1',revision,callId:'c1',sessionId:'session',taskId:'task',runId:'r1',effect:'file-read',target:{kind:'file',path:'/fixture/a.txt',name:'a.txt'},maxUses:8});
function opening(kind:Kind,requestId='req-1',callId='c1',stepId='s0'):any[]{
 const tool=kind==='scoped'?'files_read':kind==='automation'?'automation_create':'test';
 const proposed={type:'tool.proposed',runId:'r1',stepId,callId,tool,args:kind==='automation'?{name:'Synthetic'}:{},actionClass:'read'};
 if(kind==='plan')return[{type:'plan.proposed',runId:'r1',requestId,steps:['Read'],at:3}];
 if(kind==='choice')return[{type:'choice.asked',runId:'r1',stepId,callId:callId==='c1'?'ch1':callId,requestId,card,at:3}];
 if(kind==='handoff')return[proposed,{type:'handoff.required',runId:'r1',callId,requestId,reason:'Synthetic handoff'}];
 return[proposed,{type:'approval.required',runId:'r1',callId,requestId,reason:'Approve',...(kind==='scoped'&&{taskPermissionOffer:{...offer(),callId}})}];
}
const fold=(events:any[],runs:RunView[]=[])=>events.reduce((r,e)=>foldEvent(r,e as AgentEvent),runs);
function view(run:RunView){const a=activeTurnAction(run,true)!;return a.kind==='plan'?a.plan:a.kind==='choice'?a.choice:a.call;}
function drawFor(kind:Kind,item:any){
 if(kind==='plan')return()=>render(()=>PlanCard({plan:item}));
 if(kind==='choice')return()=>render(()=>ChoiceCard({choice:item}));
 if(kind==='handoff')return()=>render(()=>HandoffCard({call:item,reason:item.handoff}));
 if(kind==='automation')return()=>render(()=>AutomationSetupCard({call:item}));
 return()=>render(()=>ApprovalCard({call:item}));
}
/** The primary decision control of each card; for scoped approval, the finite-scope approve. */
function primary(kind:Kind,draw:()=>any):()=>void{
 if(kind==='automation'){const summary=nodes(draw()).find(n=>typeof n?.props?.onInstall==='function');return()=>summary.props.onInstall();}
 if(kind==='scoped'){draw();holder.hooks[0]='run';}
 return buttons(draw())[0]!.props.onClick;
}
function resolverOf(kind:Kind){return kind==='approval'||kind==='automation'?holder.state.decide:kind==='scoped'?holder.state.approveTaskPermission:kind==='handoff'?holder.state.resolveHandoff:kind==='plan'?holder.state.resolvePlan:window.vunemi.resolveChoice;}
async function setup(kind:Kind){
 holder.hooks=[];holder.index=0;holder.effect=false;
 const runs=fold([{type:'run.started',runId:'r1',goal:'Synthetic',model:'m',at:1},{type:'step.started',runId:'r1',stepId:'s0',index:0,at:2},...opening(kind)]);
 holder.state={running:true,paused:false,taskApprovalStopped:false,sessions:{current:'session'},activeRun:{sessionId:'session',runId:'r1'},runs,
  decide:vi.fn(async()=>true),resolveHandoff:vi.fn(async()=>true),resolvePlan:vi.fn(async()=>true),approveTaskPermission:vi.fn(async()=>{}),setPaneOpen:vi.fn()};
 const item=view(runs[0]!),draw=drawFor(kind,item);
 if(kind==='automation'){draw();await settle();}
 return{item,draw,click:primary(kind,draw)};
}
function move(kind:Kind,change:Change){
 const run=holder.state.runs[0] as RunView;
 if(change==='session-switched'){holder.state={...holder.state,sessions:{current:'session-b'}};return;}
 if(change==='run-ended'){holder.state={...holder.state,running:false,runs:fold([{type:'run.finished',runId:'r1',status:'stopped',detail:'Stopped',at:9}],[run])};return;}
 const next=change==='superseded-by-new-call'?opening(kind,'req-2','c2','s1'):opening(kind,'req-2');
 const events=change==='superseded-by-new-call'?[{type:'step.started',runId:'r1',stepId:'s1',index:1,at:5},...next]:next.filter(e=>e.type!=='tool.proposed');
 holder.state={...holder.state,runs:fold(events,[run])};
}
beforeEach(()=>{setLocale('en');vi.stubGlobal('window',{vunemi:{resolveChoice:vi.fn(async()=>true),summarizeAutomation:vi.fn(async()=>({})),adjustAutomation:vi.fn(async()=>true)}});});
const kinds:Kind[]=['approval','scoped','automation','handoff','plan','choice'];
const changes:Change[]=['session-switched','run-ended','superseded-by-new-call','same-call-new-request'];
it.each(kinds.flatMap(kind=>changes.map(change=>[kind,change] as const)))('%s card: captured handler makes zero decision calls after %s',async(kind,change)=>{
 const f=await setup(kind);move(kind,change);f.click();await settle();
 expect(resolverOf(kind)).not.toHaveBeenCalled();expect(window.vunemi.adjustAutomation).not.toHaveBeenCalled();
});
it.each(kinds.flatMap(kind=>(['superseded-by-new-call','same-call-new-request'] as const).map(change=>[kind,change] as const)))('%s card: after %s only the fresh card resolves, with its own request owner',async(kind,change)=>{
 const f=await setup(kind);move(kind,change);f.click();
 const fresh=view(holder.state.runs[0]);expect(fresh).not.toBe(f.item);expect(fresh.requestId).toBe('req-2');
 holder.hooks=[];holder.effect=false;const draw=drawFor(kind,fresh);if(kind==='automation'){draw();await settle();}
 primary(kind,draw)();await settle();
 const resolver=resolverOf(kind);expect(resolver).toHaveBeenCalledTimes(1);
 if(kind==='scoped')expect(resolver.mock.calls[0][1]).toBe((fresh as any).taskPermissionOffer);
 else expect(resolver.mock.calls[0].at(-1)).toEqual({runId:'r1',requestId:'req-2'});
});
it.each(['approval','automation','plan','choice'] as const)('%s card: a late false acknowledgement for a superseded request writes no state',async kind=>{
 const f=await setup(kind);let finish!:(v:boolean)=>void;resolverOf(kind).mockReturnValue(new Promise<boolean>(r=>{finish=r;}));
 f.click();const before=structuredClone(holder.hooks);move(kind,'same-call-new-request');finish(false);await settle();
 expect(holder.hooks).toEqual(before);
});
it.each(['approval','automation','plan','choice'] as const)('%s card: a late transport failure for a superseded request writes no state',async kind=>{
 const f=await setup(kind);let fail!:(e:Error)=>void;resolverOf(kind).mockReturnValue(new Promise<boolean>((_r,j)=>{fail=j;}));
 f.click();const before=structuredClone(holder.hooks);move(kind,'superseded-by-new-call');fail(Error('Old request failed'));await settle();
 expect(holder.hooks).toEqual(before);
});
it.each(['scoped','automation'] as const)('%s card: a second click before React rerenders sends nothing more',async kind=>{
 const f=await setup(kind);resolverOf(kind).mockReturnValue(new Promise(()=>{}));f.click();f.click();
 expect(resolverOf(kind)).toHaveBeenCalledTimes(1);
});
it('scoped approval: a revoked/expired offer error is visible, nothing is marked approved, and Once stays a separate exact decision',async()=>{
 const f=await setup('scoped');holder.state.approveTaskPermission.mockRejectedValue(Error('Stale task permission offer.'));f.click();await settle();
 const tree=f.draw();expect(nodes(tree).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('Stale task permission offer.'))).toBe(true);
 expect(nodes(tree).some(n=>n.props?.role==='status')).toBe(false);expect(buttons(tree)[0]!.props.disabled).toBeFalsy();expect(holder.state.decide).not.toHaveBeenCalled();
 holder.hooks[0]='once';buttons(f.draw())[0]!.props.onClick();await settle();
 expect(holder.state.decide).toHaveBeenCalledExactlyOnceWith('c1',{kind:'approve'},{runId:'r1',requestId:'req-1'});
});
it.each(['approval','automation','handoff','plan','choice'] as const)('%s card: after the run ends the folded card is terminal and offers no decision',async kind=>{
 const f=await setup(kind);move(kind,'run-ended');const run=holder.state.runs[0] as RunView;
 expect(activeTurnAction(run,true)).toBeNull();holder.hooks=[];holder.effect=false;
 const html=kind==='plan'?renderToStaticMarkup(<PlanCard plan={run.plan!}/>):kind==='choice'?renderToStaticMarkup(<ChoiceCard choice={run.steps[0]!.choices[0]!}/>):renderToStaticMarkup(<CallCard call={run.steps[0]!.calls[0]!}/>);
 for(const label of [t('call.approve'),t('call.reject'),t('call.doneContinue'),t('plan.go'),t('plan.edit')])expect(html).not.toContain(`>${label}</button>`);
 if(kind==='plan')expect(html).toContain(t('plan.cancelled'));
 else if(kind==='choice'){expect(html).toContain(t('choice.expired'));expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);}
 else{expect(html).toMatch(new RegExp(`</svg> ${callStatusLabel('cancelled')}</span>`));expect(html).not.toContain(callStatusLabel('ok'));}
 void f;
});
it('approval: an accepted decision is not shown as execution; only tool settlement marks the call done',async()=>{
 const f=await setup('approval');f.click();await settle();
 const tree=f.draw();expect(buttons(tree).every(b=>b.props.disabled)).toBe(true);expect(nodes(tree).some(n=>n.props?.role==='status')).toBe(false);
 const run=holder.state.runs[0] as RunView,decided=fold([{type:'approval.resolved',runId:'r1',callId:'c1',decision:{kind:'approve'}}],[run]);
 expect(decided[0]!.steps[0]!.calls[0]!.status).toBe('proposed');holder.hooks=[];
 const html=renderToStaticMarkup(<CallCard call={decided[0]!.steps[0]!.calls[0]!}/>);expect(html).toContain(`aria-label="${callStatusLabel('proposed')}"`);expect(html).not.toContain(`aria-label="${callStatusLabel('ok')}"`);
 const stopped=fold([{type:'run.finished',runId:'r1',status:'stopped',detail:'Stopped',at:9}],decided);expect(stopped[0]!.steps[0]!.calls[0]!.status).toBe('cancelled');
 const executed=fold([{type:'tool.started',runId:'r1',callId:'c1',at:6},{type:'tool.finished',runId:'r1',callId:'c1',ok:true,output:'Synthetic',durationMs:1}],decided);expect(executed[0]!.steps[0]!.calls[0]!.status).toBe('ok');
});

// Recovery is the remaining decision card without a captured-owner recheck.
function recovery(){
 holder.hooks=[];holder.index=0;holder.effect=true;
 holder.state={running:false,model:'local-model',sessions:{current:'session-a',sessions:[{id:'session-a',title:'A',updatedAt:1,runs:1,interrupted:{steps:2}},{id:'session-b',title:'B',updatedAt:1,runs:1,interrupted:{steps:3}}],projects:[]},setSessions:vi.fn()};
 const api={resumeInterrupted:vi.fn(async()=>{}),dismissInterrupted:vi.fn(async()=>holder.state.sessions)};vi.stubGlobal('window',{vunemi:api});
 const draw=()=>render(()=>RecoveryActions({}));const [resume,dismiss]=buttons(draw());return{api,draw,resume:resume!.props.onClick,dismiss:dismiss!.props.onClick};
}
it.each(['resume','dismiss'] as const)('recovery: captured %s makes no call after the conversation changes',which=>{
 const f=recovery();holder.state={...holder.state,sessions:{...holder.state.sessions,current:'session-b'}};f[which]();
 expect(f.api.resumeInterrupted).not.toHaveBeenCalled();expect(f.api.dismissInterrupted).not.toHaveBeenCalled();
});
it('recovery: captured Resume makes no call once a run is active',()=>{const f=recovery();holder.state={...holder.state,running:true};f.resume();expect(f.api.resumeInterrupted).not.toHaveBeenCalled();});
it('recovery: a second click before React rerenders sends one request',()=>{const f=recovery();f.api.resumeInterrupted.mockReturnValue(new Promise(()=>{}));f.resume();f.resume();f.dismiss();expect(f.api.resumeInterrupted).toHaveBeenCalledExactlyOnceWith('local-model','session-a');expect(f.api.dismissInterrupted).not.toHaveBeenCalled();});
it('recovery: a late failure from the previous conversation is not shown on the next one',async()=>{
 const f=recovery();let fail!:(e:Error)=>void;f.api.resumeInterrupted.mockReturnValue(new Promise((_r,j)=>{fail=j;}));f.resume();
 const before=structuredClone(holder.hooks);holder.state={...holder.state,sessions:{...holder.state.sessions,current:'session-b'}};fail(Error('Old resume failed'));await settle();
 expect(holder.hooks).toEqual(before);
});
it('recovery: a resume failure in the same conversation is visible and releases busy',async()=>{
 const f=recovery();f.api.resumeInterrupted.mockRejectedValue(Error('Synthetic resume failure'));f.resume();await settle();
 const tree=f.draw();expect(nodes(tree).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('Synthetic resume failure'))).toBe(true);expect(buttons(tree)[0]!.props.disabled).toBeFalsy();
});
it('recovery: a late dismiss result cannot replace the list after the conversation changes',async()=>{
 const f=recovery();let finish!:(v:any)=>void;f.api.dismissInterrupted.mockReturnValue(new Promise(r=>{finish=r;}));f.dismiss();
 holder.state={...holder.state,sessions:{...holder.state.sessions,current:'session-b'}};finish({current:'session-a',sessions:[],projects:[]});await settle();
 expect(holder.state.setSessions).not.toHaveBeenCalled();
});
