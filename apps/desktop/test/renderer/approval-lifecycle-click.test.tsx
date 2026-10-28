import {beforeEach,expect,it,vi} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {ApprovalCard,HandoffCard,AutomationSetupCard} from '../../src/renderer/src/components/CallCard.js';
import {PlanCard} from '../../src/renderer/src/components/PlanCard.js';
import {ChoiceCard} from '../../src/renderer/src/components/ChoiceCard.js';
const holder=vi.hoisted(()=>({state:{} as any,hooks:[] as any[],index:0,effect:false}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>{const i=holder.index++;if(!(i in holder.hooks))holder.hooks[i]=typeof initial==='function'?initial():initial;return[holder.hooks[i],(next:any)=>{holder.hooks[i]=typeof next==='function'?next(holder.hooks[i]):next;}];},useEffect:(fn:()=>void)=>{if(!holder.effect){holder.effect=true;fn();}}}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((pick:any)=>pick(holder.state),{getState:()=>holder.state})}));
function render(fn:()=>any){holder.index=0;return fn();}
function nodes(node:any):any[]{if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
function buttons(node:any){return nodes(node).filter(n=>n.type==='button');}
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
beforeEach(()=>{holder.hooks=[];holder.index=0;holder.effect=false;setLocale('en');vi.stubGlobal('window',{vunemi:{resolveChoice:vi.fn(async()=>true),summarizeAutomation:vi.fn(async()=>({})),adjustAutomation:vi.fn(async()=>true)}});});
function setup(kind:'approval'|'handoff'|'plan'|'choice'){
 const call={callId:'same-call',requestId:'request-one',tool:'test',args:{},actionClass:'read',status:kind==='approval'?'awaiting':'running',...(kind==='handoff'?{handoff:'Help'}:{})};
 const plan={requestId:'request-one',steps:['Read'],status:'awaiting'},choice={requestId:'request-one',runId:'run-one',callId:'same-call',card:{kind:'choice',question:'Q',options:['A','B']},status:'awaiting'};
 const run={runId:'run-one',status:'running',pendingAction:{kind,callId:'same-call'},plan,steps:[{calls:[call],choices:[choice]}]};
 holder.state={running:true,paused:false,taskApprovalStopped:false,sessions:{current:'session'},activeRun:{sessionId:'session',runId:'run-one'},runs:[run],decide:vi.fn(async()=>true),resolveHandoff:vi.fn(async()=>true),resolvePlan:vi.fn(async()=>true),setPaneOpen:vi.fn()};
 const draw=()=>render(()=>kind==='approval'?ApprovalCard({call:call as any}):kind==='handoff'?HandoffCard({call:call as any,reason:'Help'}):kind==='plan'?PlanCard({plan:plan as any}):ChoiceCard({choice:choice as any}));
 return{call,plan,choice,run,draw,resolver:kind==='approval'?holder.state.decide:kind==='handoff'?holder.state.resolveHandoff:kind==='plan'?holder.state.resolvePlan:window.vunemi.resolveChoice};
}
it.each(['approval','handoff','plan','choice'] as const)('%s captured handler cannot resolve a new run reusing call IDs',kind=>{
 const f=setup(kind),click=buttons(f.draw())[0]!.props.onClick;
 holder.state.activeRun={sessionId:'session',runId:'run-two'};f.run.runId='run-two';
 click();expect(f.resolver).not.toHaveBeenCalled();
});
it.each(['approval','handoff','plan','choice'] as const)('%s makes zero decisions after Stop intent or pause',kind=>{
 const f=setup(kind),click=buttons(f.draw())[0]!.props.onClick;
 holder.state.taskApprovalStopped=true;click();holder.state.taskApprovalStopped=false;holder.state.paused=true;click();expect(f.resolver).not.toHaveBeenCalled();
});
it.each(['approval','handoff','plan','choice'] as const)('%s sends only one decision before React rerenders',kind=>{
 const f=setup(kind);f.resolver.mockReturnValue(new Promise(()=>{}));const controls=buttons(f.draw());controls[0]!.props.onClick();controls.at(-1)!.props.onClick();expect(f.resolver).toHaveBeenCalledTimes(1);
});
it.each(['approval','handoff','plan'] as const)('%s sends exact request owner and handles false acknowledgement as terminal',async kind=>{
 const f=setup(kind);f.resolver.mockResolvedValue(false);buttons(f.draw())[0]!.props.onClick();await settle();
 expect(f.resolver.mock.calls[0].at(-1)).toEqual({runId:'run-one',requestId:'request-one'});
 const tree=f.draw();expect(nodes(tree).some(n=>n.props?.role==='status')).toBe(true);expect(buttons(tree).every(b=>b.props.disabled)).toBe(true);
});
it.each(['approval','handoff','plan','choice'] as const)('%s shows transport failure and releases busy state',async kind=>{
 const f=setup(kind);f.resolver.mockRejectedValue(Error('Synthetic transport failure'));buttons(f.draw())[0]!.props.onClick();await settle();
 const tree=f.draw();expect(nodes(tree).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('Synthetic transport failure'))).toBe(true);expect(buttons(tree)[0]!.props.disabled).toBeFalsy();
});
it('expires a false-ack choice and prevents another answer',async()=>{
 const f=setup('choice');(f.resolver as any).mockResolvedValue(false);buttons(f.draw())[0]!.props.onClick();await settle();
 const tree=f.draw();expect(buttons(tree).every(b=>b.props.disabled)).toBe(true);
 buttons(tree)[0]!.props.onClick();expect(f.resolver).toHaveBeenCalledTimes(1);
});
it('late handoff rejection cannot write state after request replacement',async()=>{
 const f=setup('handoff');let reject!:(e:Error)=>void;f.resolver.mockReturnValue(new Promise((_resolve,r)=>{reject=r;}));buttons(f.draw())[0]!.props.onClick();
 const before=[...holder.hooks];f.run.steps[0]!.calls=[{...f.call,requestId:'new-request'}];reject(Error('Old request failed'));await settle();expect(holder.hooks).toEqual(before);
});
it('guards automation install and cancel, including owner drift during schedule adjustment',async()=>{
 const f=setup('approval');f.call.tool='automation_create';
 const draw=()=>render(()=>AutomationSetupCard({call:f.call as any}));draw();await settle();
 let tree=draw(),summary=nodes(tree).find(n=>typeof n.props?.onInstall==='function')!;
 holder.state.taskApprovalStopped=true;summary.props.onInstall();summary.props.onCancel();expect(holder.state.decide).not.toHaveBeenCalled();expect(window.vunemi.adjustAutomation).not.toHaveBeenCalled();
 holder.state.taskApprovalStopped=false;(window.vunemi.adjustAutomation as any).mockImplementation(async()=>{f.run.pendingAction={kind:'handoff',callId:'other'};});
 summary.props.onInstall({time:'12:00',days:[1]});await settle();expect(window.vunemi.adjustAutomation).toHaveBeenCalledTimes(1);expect(holder.state.decide).not.toHaveBeenCalled();
});
it('rejects stale automation adjustment acknowledgement without approving',async()=>{
 const f=setup('approval');f.call.tool='automation_create';const draw=()=>render(()=>AutomationSetupCard({call:f.call as any}));draw();await settle();
 (window.vunemi.adjustAutomation as any).mockResolvedValue(false);const summary=nodes(draw()).find(n=>typeof n.props?.onInstall==='function')!;
 summary.props.onInstall({time:'12:00',days:[1]});await settle();
 expect(window.vunemi.adjustAutomation).toHaveBeenCalledWith(f.call.args,{time:'12:00',days:[1]},'same-call',{runId:'run-one',requestId:'request-one'});
 expect(holder.state.decide).not.toHaveBeenCalled();expect(nodes(draw()).some(n=>n.props?.role==='status')).toBe(true);
});
it('automation cancellation transport failure is visible and releases busy',async()=>{
 const f=setup('approval');f.call.tool='automation_create';const draw=()=>render(()=>AutomationSetupCard({call:f.call as any}));draw();await settle();
 holder.state.decide.mockRejectedValue(Error('Synthetic cancel failure'));nodes(draw()).find(n=>typeof n.props?.onCancel==='function')!.props.onCancel();await settle();
 const summary=nodes(draw()).find(n=>typeof n.props?.onCancel==='function')!;expect(summary.props.error).toBe('Synthetic cancel failure');expect(summary.props.busy).toBe(false);
});
