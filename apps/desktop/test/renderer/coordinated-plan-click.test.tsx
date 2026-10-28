import {it,expect,vi} from 'vitest';
import type {ReactElement} from 'react';
import {PlanCard} from '../../src/renderer/src/components/PlanCard.js';
import type {PlanView,RunView} from '../../src/renderer/src/lib/fold.js';
const holder=vi.hoisted(()=>({state:null as any}));
vi.mock('react',async(load)=>({...await load<typeof import('react')>(),useState:(value:unknown)=>[value,vi.fn()]}));
vi.mock('../../src/renderer/src/store.js',()=>({useStore:Object.assign((selector:(s:any)=>unknown)=>selector(holder.state),{getState:()=>holder.state})}));
function handlers(node:any):Array<()=>void>{if(!node||typeof node!=='object')return [];return [...(node.type==='button'&&node.props.onClick?[node.props.onClick]:[]),...[node.props?.children].flat(Infinity).flatMap(handlers)];}
function setup(){const plan:PlanView={requestId:'plan-request',status:'awaiting',steps:['Actual plan']};const run:RunView={runId:'r',goal:'test',model:'local',status:'running',startedAt:1,steps:[],plan,pendingAction:{kind:'plan'}};const resolvePlan=vi.fn(async()=>{});holder.state={sessions:{current:'session-a'},running:true,activeRun:{runId:'r',sessionId:'session-a'},runs:[run],resolvePlan};const clicks=handlers(PlanCard({plan}) as ReactElement);return {resolvePlan,clicks,run};}
it.each(['session','run','stopped','resolved','superseded'] as const)('a captured plan approval handler cannot resolve after %s changes',change=>{const {resolvePlan,clicks,run}=setup();if(change==='session')holder.state={...holder.state,sessions:{current:'session-b'}};if(change==='run')holder.state.runs=[{...run,runId:'other'}];if(change==='stopped')holder.state.running=false;if(change==='resolved')holder.state.runs=[{...run,pendingAction:undefined}];if(change==='superseded')holder.state.runs=[{...run,pendingAction:{kind:'approval',callId:'new'}}];clicks.forEach(click=>click());expect(resolvePlan).not.toHaveBeenCalled();});
it('current plan approval retains the actual resolver and chosen steps',()=>{const {resolvePlan,clicks}=setup();clicks[0]!();expect(resolvePlan).toHaveBeenCalledWith({kind:'go',steps:['Actual plan']},{runId:'r',requestId:'plan-request'});});
