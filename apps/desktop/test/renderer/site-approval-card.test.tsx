import {beforeEach,expect,it,vi} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {ApprovalCard} from '../../src/renderer/src/components/CallCard.js';
import {foldEvent,type RunView} from '../../src/renderer/src/lib/fold.js';
const holder=vi.hoisted(()=>({state:{} as any,hooks:[] as any[],index:0}));
vi.mock('react',async load=>({...await load<typeof import('react')>(),useState:(initial:any)=>{const i=holder.index++;if(!(i in holder.hooks))holder.hooks[i]=typeof initial==='function'?initial():initial;return[holder.hooks[i],(next:any)=>{holder.hooks[i]=typeof next==='function'?next(holder.hooks[i]):next;}];}}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((pick:any)=>pick(holder.state),{getState:()=>holder.state})}));
function nodes(node:any):any[]{if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
const text=(node:any)=>nodes(node).flatMap(n=>[n.props?.children].flat(Infinity)).filter(c=>typeof c==='string').join(' ');
const buttons=(node:any)=>nodes(node).filter(n=>n.type==='button');
const labelled=(node:any,label:string)=>buttons(node).find(b=>[b.props.children].flat(Infinity).join('')===label);
function setup(extra:Record<string,unknown>={}){
 const call={callId:'c',requestId:'request',tool:'page_click',args:{ref:12},actionClass:'outbound',status:'awaiting',approveAll:{site:'example.com'},...extra};
 holder.state={running:true,paused:false,taskApprovalStopped:false,sessions:{current:'session'},activeRun:{sessionId:'session',runId:'r'},runs:[{runId:'r',status:'running',pendingAction:{kind:'approval',callId:'c'},steps:[{calls:[call],choices:[]}]}],decide:vi.fn(async()=>true)};
 return{call,draw:()=>{holder.index=0;return ApprovalCard({call:call as any});}};
}
const added=vi.fn();
beforeEach(()=>{holder.hooks=[];holder.index=0;setLocale('en');added.mockReset();added.mockImplementation(async(host:string)=>({ok:true,sites:[host],host}));vi.stubGlobal('window',{vunemi:{addTrustedSite:added}});});
const flush=()=>new Promise(r=>setTimeout(r,0));

it('a site card says what the button covers, and offers to trust the site',()=>{
 const card=setup().draw();
 expect(text(card)).toContain("Until this task ends, clicks and typing on example.com and local changes won't ask again. Forms that send data, sending and deleting still ask.");
 expect(labelled(card,'Trust example.com')).toBeDefined();
 expect(text(card)).toContain('From now on, one approval per task is enough on this site.');
 expect(labelled(card,'Approve all in this task')).toBeDefined();
});

it('pressing Trust adds the site the card names, then approves the rest of the task there',async()=>{
 const f=setup();
 labelled(f.draw(),'Trust example.com').props.onClick();
 await flush();await flush();
 expect(added).toHaveBeenCalledWith('example.com');
 expect(holder.state.decide).toHaveBeenCalledWith('c',{kind:'approve_all'},expect.anything());
 // The site was added before the answer went out.
 expect(added.mock.invocationCallOrder[0]).toBeLessThan(holder.state.decide.mock.invocationCallOrder[0]);
});

it('a site that cannot be trusted says why and approves nothing',async()=>{
 added.mockImplementation(async()=>({ok:false,reason:'full'}));
 const f=setup();
 labelled(f.draw(),'Trust example.com').props.onClick();
 await flush();await flush();
 expect(holder.state.decide).not.toHaveBeenCalled();
 expect(text(f.draw())).toContain('The list is full.');
});

it('a trusted site shows that one approval covers it, and no trust control',()=>{
 const card=setup({approveAll:{site:'example.com',trusted:true}}).draw();
 expect(text(card)).toContain('example.com is a trusted site: approving covers clicks and typing there until this task ends.');
 expect(buttons(card).some(b=>String([b.props.children].flat(Infinity).join('')).startsWith('Trust '))).toBe(false);
});

it('a card without a site is as before',()=>{
 const card=setup({tool:'desktop_type',args:{app:'TextEdit'},approveAll:{app:'TextEdit'}}).draw();
 expect(text(card)).toContain("Until this task ends, TextEdit and local changes won't ask again.");
 expect(buttons(card).some(b=>String([b.props.children].flat(Infinity).join('')).startsWith('Trust '))).toBe(false);
 expect(text(card)).not.toContain('trusted site');
});

it('a warning card offers neither the button nor the trust control',()=>{
 const card=setup({alert:true,reason:'Careful.'}).draw();
 expect(labelled(card,'Approve all in this task')).toBeUndefined();
 expect(labelled(card,'Trust example.com')).toBeUndefined();
});

it('a run keeps the site and whether it is trusted on the card',()=>{
 let runs:RunView[]=foldEvent([],{type:'run.started',runId:'r',goal:'g',model:'m',at:1} as any);
 for(const e of [{type:'step.started',runId:'r',stepId:'s0',index:0},{type:'tool.proposed',runId:'r',stepId:'s0',callId:'c',tool:'page_click',args:{},actionClass:'outbound'},{type:'approval.required',runId:'r',stepId:'s0',callId:'c',tool:'page_click',args:{},actionClass:'outbound',reason:'',approveAll:{site:'example.com',trusted:true}}] as any[])runs=foldEvent(runs,e);
 expect(runs[0]!.steps[0]!.calls[0]!.approveAll).toEqual({site:'example.com',trusted:true});
});
