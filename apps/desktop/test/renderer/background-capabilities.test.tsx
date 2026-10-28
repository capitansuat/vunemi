import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale, t} from '@vunemi/i18n';
import {parseBackgroundCapabilities} from '../../src/renderer/src/lib/background-capabilities.js';
import {BackgroundCapabilitiesCard} from '../../src/renderer/src/components/BackgroundCapabilitiesCard.js';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}));
const payload=()=>({snapshotId:'snapshot-real',windowId:42,windowTitle:'Calculator',bundleId:'com.apple.calculator',processStartedAt:10,controlMode:'backgroundStrict',targets:[{ref:1,role:'AXButton',label:'7',backgroundActions:['press']}],capabilities:{version:1,controlMode:'backgroundStrict',status:'observed',observedActions:['press'],unsupportedActions:['menu','scroll','drag'],reasonCode:'eligible-targets-observed'}});
const call=(value:unknown)=>({tool:'desktop_background_describe',status:'ok' as const,output:JSON.stringify(value)});
it('accepts actual observed actions from raw JSON and the exact tool output fence',()=>{
 const raw=call(payload());expect(parseBackgroundCapabilities(raw)?.observedActions).toEqual(['press']);expect(parseBackgroundCapabilities({...raw,output:`<untrusted_content source="desktop_background_describe">\n${raw.output}\n</untrusted_content>`})?.windowTitle).toBe('Calculator');
});
it.each(['error','running','awaiting'] as const)('does not claim capabilities for %s results',status=>expect(parseBackgroundCapabilities({...call(payload()),status})).toBeNull());
it('rejects other tools, wrong fences and partial/truncated JSON without extracting embedded blobs',()=>{
 const raw=call(payload());expect(parseBackgroundCapabilities({...raw,tool:'files_read'})).toBeNull();expect(parseBackgroundCapabilities({...raw,output:`<untrusted_content source="files_read">\n${raw.output}\n</untrusted_content>`})).toBeNull();expect(parseBackgroundCapabilities({...raw,output:`prefix ${raw.output} suffix`})).toBeNull();expect(parseBackgroundCapabilities({...raw,output:raw.output.slice(0,-20)})).toBeNull();
});
it('requires coherent native identity, supported action enums and observed target evidence',()=>{
 for(const mutate of [(p:any)=>delete p.snapshotId,(p:any)=>p.windowId=0,(p:any)=>p.controlMode='foreground',(p:any)=>p.capabilities.version=2,(p:any)=>p.capabilities.observedActions=['drag'],(p:any)=>p.targets=[],(p:any)=>p.targets[0].role='AXTextArea',(p:any)=>p.targets[0].enabled=false,(p:any)=>p.targets[0].subrole='AXSecureTextField']){const p=payload();mutate(p);expect(parseBackgroundCapabilities(call(p))).toBeNull()}
});
it('empty targets mean only no eligible actions in this observation, including other app families',()=>{
 const p:any=payload();p.bundleId='com.electron.example';p.targets=[];p.capabilities.status='no-actions-observed';p.capabilities.observedActions=[];p.capabilities.reasonCode='no-eligible-targets-observed';expect(parseBackgroundCapabilities(call(p))?.observedActions).toEqual([]);
});
it('renders observation-only, no action controls, sensitive values or snapshot identifiers',()=>{
 setLocale('en');const p:any=payload();p.targets[0].value='SECRET_VALUE';const view=parseBackgroundCapabilities(call(p))!;const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={view}/>);expect(html).toContain('Calculator');expect(html).toContain(t('backgroundCapabilities.observationOnly'));expect(html).not.toContain('<button');expect(html).not.toContain('SECRET_VALUE');expect(html).not.toContain('snapshot-real');expect(html).toContain(t('backgroundCapabilities.actions.scroll'));
});
it('escapes observed window titles rather than interpreting markup',()=>{
 const p=payload();p.windowTitle='<img src=x onerror=alert(1)>';const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={parseBackgroundCapabilities(call(p))!}/>);expect(html).toContain('&lt;img');expect(html).not.toContain('<img');
});
it('shows a real completed observation on its call row without any approval controls',async()=>{
 const {CallCard}=await import('../../src/renderer/src/components/CallCard.js');const html=renderToStaticMarkup(<CallCard call={{...call(payload()),callId:'cap',args:{app:'Calculator'},actionClass:'read'}}/>);expect(html).toContain('data-background-capabilities');expect(html).not.toContain('>Approve</button>');
});
it('promotes exactly the latest observation out of folded task history, never revives an older one after failure',async()=>{
 const {Turn}=await import('../../src/renderer/src/components/Turn.js');const {foldEvent}=await import('../../src/renderer/src/lib/fold.js');const {tasksFromEvents}=await import('@vunemi/agent-core');
 const events:import('@vunemi/agent-core').AgentEvent[]=[{type:'run.started',runId:'r',goal:'Inspect background capabilities',model:'local',at:1},{type:'plan.resolved',runId:'r',decision:{kind:'go',steps:['Inspect window']}}];
 for(const [i,title]of ['Old window','Current window'].entries()){
  const p=payload();p.windowTitle=title;events.push({type:'step.started',runId:'r',stepId:`s${i}`,index:i,at:2+i},{type:'tool.proposed',runId:'r',stepId:`s${i}`,callId:`c${i}`,tool:'desktop_background_describe',args:{app:'Calculator'},actionClass:'read'},{type:'tool.finished',runId:'r',callId:`c${i}`,ok:true,output:JSON.stringify(p),durationMs:1});
 }
 const final=(source:import('@vunemi/agent-core').AgentEvent[])=>[...source,{type:'step.started',runId:'r',stepId:'answer',index:4,at:5},{type:'message.delta',runId:'r',stepId:'answer',text:'Observation finished.'},{type:'run.finished',runId:'r',status:'done',detail:'',at:6}]as import('@vunemi/agent-core').AgentEvent[];
 const render=(source:import('@vunemi/agent-core').AgentEvent[])=>renderToStaticMarkup(<Turn run={source.reduce(foldEvent,[]as import('../../src/renderer/src/lib/fold.js').RunView[])[0]!} task={tasksFromEvents(source)[0]}/>);
 const html=render(final(events));expect(html.split('data-background-capabilities').length-1).toBe(1);expect(html).toContain('Current window');expect(html).not.toContain('Old window');expect(html.indexOf('data-background-capabilities')).toBeLessThan(html.indexOf('class="group rounded-lg px-1 py-1"'));
 events.push({type:'step.started',runId:'r',stepId:'failed',index:3,at:4},{type:'tool.proposed',runId:'r',stepId:'failed',callId:'failed',tool:'desktop_background_describe',args:{app:'Calculator'},actionClass:'read'},{type:'tool.finished',runId:'r',callId:'failed',ok:false,output:'Target is unavailable.',durationMs:1});
 const failed=render(final(events));expect(failed).not.toContain('data-background-capabilities');expect(failed).toContain('Target is unavailable.');
});
it('uses the native observed app name and falls back to bundle identity only when absent',()=>{
 const p:any=payload();p.app='Calculator';const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={parseBackgroundCapabilities(call(p))!}/>);expect(html).toContain('Calculator');expect(html).not.toContain('com.apple.calculator');delete p.app;expect(renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={parseBackgroundCapabilities(call(p))!}/>)).toContain('com.apple.calculator');p.app='x'.repeat(501);expect(parseBackgroundCapabilities(call(p))).toBeNull();
});
it.each(['com.example.native','com.example.electron','com.example.browser','com.example.canvas'])('does not invent actions for an empty observed target set in %s',bundleId=>{
 const p:any=payload();p.bundleId=bundleId;p.targets=[];p.capabilities.status='no-actions-observed';p.capabilities.observedActions=[];p.capabilities.reasonCode='no-eligible-targets-observed';const view=parseBackgroundCapabilities(call(p))!;expect(view.observedActions).toEqual([]);const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={view}/>);expect(html).toContain(t('backgroundCapabilities.none'));expect(html).not.toContain(t('backgroundCapabilities.actions.press'));
});
it('accepts observed TextEdit set-value without exposing its field contents',()=>{
 const p:any=payload();p.app='TextEdit';p.bundleId='com.apple.TextEdit';p.windowTitle='report.txt';p.targets=[{ref:1,role:'AXTextArea',label:'text',value:'PRIVATE_DOCUMENT',backgroundActions:['set-value']}];p.capabilities.observedActions=['set-value'];const view=parseBackgroundCapabilities(call(p))!;expect(view.observedActions).toEqual(['set-value']);expect(renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={view}/>)).not.toContain('PRIVATE_DOCUMENT');
});
