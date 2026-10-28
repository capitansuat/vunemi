import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseBackgroundCapabilities} from '../../src/renderer/src/lib/background-capabilities.js';
import {BackgroundCapabilitiesCard} from '../../src/renderer/src/components/BackgroundCapabilitiesCard.js';
import {t} from '@vunemi/i18n';
const payload=()=>({kind:'bound-browser-observation',version:1,backend:'owned-web-content',controlMode:'backgroundStrict',title:'Synthetic canvas',origin:'https://example.test',url:'https://example.test/fixture',observationOnly:true,screenshotObserved:true,bindingId:'private-binding',snapshotId:'private-binding',targetId:'private-target',frameId:'private-frame',loaderId:'private-loader',width:1000,height:700,scale:1,readback:{text:'PRIVATE_FIELD_VALUE'}});
const call=(value:unknown)=>({tool:'page_target_observe',status:'ok' as const,output:`<untrusted_content source="page_target_observe">\n${JSON.stringify(value)}\n</untrusted_content>`});
it('shows the owned browser observation without inventing supported actions or exposing private handles',()=>{
 const view=parseBackgroundCapabilities(call(payload()));expect(view).toMatchObject({backend:'owned-web-content',targetKind:'page',actionAvailability:'per-action',observedActions:[],unsupportedActions:[]});
 const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={view!}/>);expect(html).toContain('Synthetic canvas');expect(html).toContain('https://example.test');expect(html).toContain(t('backgroundCapabilities.perAction'));
 for(const hidden of ['PRIVATE_FIELD_VALUE','private-binding','private-target','private-frame','private-loader','<button'])expect(html).not.toContain(hidden);
 expect(html).not.toContain(t('backgroundCapabilities.none'));expect(html).not.toContain(t('backgroundCapabilities.notProvided'));
});
it.each(['backend','origin','identity','version','observation','geometry','fence'])('rejects malformed bound observation %s',kind=>{
 const p:any=payload();if(kind==='backend')p.backend='unknown';if(kind==='origin')p.origin='https://another.test';if(kind==='identity')p.snapshotId='other-binding';if(kind==='version')p.version=2;if(kind==='observation')p.observationOnly=false;if(kind==='geometry')p.width=-1;const c=call(p);if(kind==='fence')c.output=c.output.replace('source="page_target_observe"','source="another_tool"');expect(parseBackgroundCapabilities(c)).toBeNull();
});
it('uses the latest web observation across native history and hides it after a later failed native observation',async()=>{
 const {Turn}=await import('../../src/renderer/src/components/Turn.js');const {foldEvent}=await import('../../src/renderer/src/lib/fold.js');const {tasksFromEvents}=await import('@vunemi/agent-core');
 const native={snapshotId:'old',windowId:42,windowTitle:'Old native window',bundleId:'com.apple.calculator',processStartedAt:10,controlMode:'backgroundStrict',targets:[{ref:1,role:'AXButton',label:'7',backgroundActions:['press']}],capabilities:{version:1,controlMode:'backgroundStrict',status:'observed',observedActions:['press'],unsupportedActions:['menu','scroll','drag'],reasonCode:'eligible-targets-observed'}};
 const events:import('@vunemi/agent-core').AgentEvent[]=[{type:'run.started',runId:'r',goal:'Inspect targets',model:'test',at:1},{type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['Inspect']}}];
 const add=(id:string,tool:string,ok:boolean,output:string)=>events.push({type:'step.started',runId:'r',stepId:id,index:events.length,at:2},{type:'tool.proposed',runId:'r',stepId:id,callId:id,tool,args:{},actionClass:'read'},{type:'tool.finished',runId:'r',callId:id,ok,output,durationMs:1});
 add('old','desktop_background_describe',true,JSON.stringify(native));add('web','page_target_observe',true,call(payload()).output);
 const render=()=>{const source=[...events,{type:'run.finished',runId:'r',status:'done',detail:'',at:9}] as import('@vunemi/agent-core').AgentEvent[];return renderToStaticMarkup(<Turn run={source.reduce(foldEvent,[]as import('../../src/renderer/src/lib/fold.js').RunView[])[0]!} task={tasksFromEvents(source)[0]}/>)};
 const html=render();expect(html.split('data-background-capabilities').length-1).toBe(1);expect(html).toContain('Synthetic canvas');expect(html).not.toContain('Old native window');
 add('failed','desktop_background_describe',false,'Target unavailable');expect(render()).not.toContain('data-background-capabilities');
});
