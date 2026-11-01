import {beforeEach,expect,it,vi} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {ApprovalCard,ApprovedAllRow} from '../../src/renderer/src/components/CallCard.js';
import {foldEvent,type RunView} from '../../src/renderer/src/lib/fold.js';
const holder=vi.hoisted(()=>({state:{} as any,hooks:[] as any[],index:0}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>{const i=holder.index++;if(!(i in holder.hooks))holder.hooks[i]=typeof initial==='function'?initial():initial;return[holder.hooks[i],(next:any)=>{holder.hooks[i]=typeof next==='function'?next(holder.hooks[i]):next;}];}}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((pick:any)=>pick(holder.state),{getState:()=>holder.state})}));
function nodes(node:any):any[]{if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
const text=(node:any)=>nodes(node).flatMap(n=>[n.props?.children].flat(Infinity)).filter(c=>typeof c==='string').join(' ');
const buttons=(node:any)=>nodes(node).filter(n=>n.type==='button');
function setup(extra:Record<string,unknown>={}){
 const call={callId:'c',requestId:'request',tool:'desktop_type',args:{app:'TextEdit'},actionClass:'outbound',status:'awaiting',approveAll:{app:'TextEdit'},...extra};
 holder.state={running:true,paused:false,taskApprovalStopped:false,sessions:{current:'session'},activeRun:{sessionId:'session',runId:'r'},runs:[{runId:'r',status:'running',pendingAction:{kind:'approval',callId:'c'},steps:[{calls:[call],choices:[]}]}],decide:vi.fn(async()=>true),endApproveAll:vi.fn(async()=>{})};
 return{call,draw:()=>{holder.index=0;return ApprovalCard({call:call as any});}};
}
beforeEach(()=>{holder.hooks=[];holder.index=0;setLocale('en');});
it('offers it, says what stays out, and sends the decision',()=>{
 const f=setup(),card=f.draw();
 expect(text(card)).toContain("TextEdit and local changes won't ask again. Sending and deleting still ask.");
 buttons(card).find(b=>b.props.children==='Approve all in this task').props.onClick();
 expect(holder.state.decide).toHaveBeenCalledWith('c',{kind:'approve_all'},expect.anything());
});
it('leaves it off local-only wording when no app is reached',()=>{
 const card=setup({approveAll:{}}).draw();
 expect(text(card)).toContain("local changes won't ask again");
 expect(text(card)).not.toContain('TextEdit and local');
});
it.each([[{approveAll:undefined}],[{alert:true,reason:'Careful.'}],[{switchedOff:'Notes › Write'}]])('has no button on %j',extra=>{
 const card=setup(extra).draw();
 expect(buttons(card).some(b=>b.props.children==='Approve all in this task')).toBe(false);
});
it('Ask again ends it for this run',()=>{
 setup();holder.index=0;
 const row=ApprovedAllRow({runId:'r'});
 expect(text(row)).toContain('All approved in this task');
 buttons(row)[0].props.onClick();
 expect(holder.state.endApproveAll).toHaveBeenCalledWith('r');
});
it('a run shows it from the decision until it ends',()=>{
 const start={type:'run.started',runId:'r',goal:'g',model:'m',at:1} as any;
 let runs:RunView[]=foldEvent([],start);
 for(const e of [{type:'step.started',runId:'r',stepId:'s0',index:0},{type:'tool.proposed',runId:'r',stepId:'s0',callId:'c',tool:'t',args:{},actionClass:'write-local'},{type:'approval.required',runId:'r',stepId:'s0',callId:'c',tool:'t',args:{},actionClass:'write-local',reason:'',approveAll:{app:'TextEdit'}}] as any[])runs=foldEvent(runs,e);
 expect(runs[0]!.steps[0]!.calls[0]!.approveAll).toEqual({app:'TextEdit'});expect(runs[0]!.approvedAll).toBeFalsy();
 runs=foldEvent(runs,{type:'approval.resolved',runId:'r',callId:'c',decision:{kind:'approve_all'}});
 expect(runs[0]!.approvedAll).toBe(true);expect(runs[0]!.steps[0]!.calls[0]!.status).toBe('proposed');
 runs=foldEvent(runs,{type:'approval.all_ended',runId:'r',at:2});
 expect(runs[0]!.approvedAll).toBe(false);
});
