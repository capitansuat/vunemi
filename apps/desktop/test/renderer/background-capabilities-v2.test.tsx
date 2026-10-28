import {t} from '@vunemi/i18n';
import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseBackgroundCapabilities} from '../../src/renderer/src/lib/background-capabilities.js';
import {BackgroundCapabilitiesCard} from '../../src/renderer/src/components/BackgroundCapabilitiesCard.js';
const payload=()=>({snapshotId:'private-snapshot',windowId:3,pid:42,processStartedAt:100,bundleId:'com.apple.TextEdit',app:'TextEdit',windowTitle:'Synthetic report',controlMode:'backgroundStrict',targets:[],extendedTargets:[{ref:2,role:'AXScrollBar',label:'Private label',profile:'textedit-scroll-v1',actions:['scroll-position'],scroll:{current:.123456,min:0,max:1,axis:'vertical'}}],capabilitiesV2:{version:2,backend:'native-ax',controlMode:'backgroundStrict',status:'observed',observedActions:['scroll-position'],unsupportedActions:['press','set-value','menu-open','menu-select','drag'],reasonCode:'eligible-targets-observed'}});
const call=(value:unknown)=>({tool:'desktop_background_describe',status:'ok' as const,output:JSON.stringify(value)});
it('projects actual v2 scroll metadata and keeps private target and position details out of the card',()=>{
 const view=parseBackgroundCapabilities(call(payload()));expect(view).toMatchObject({backend:'native-ax',observedActions:['scroll-position']});
 const html=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={view!}/>);expect(html).toContain('TextEdit');for(const privateValue of ['private-snapshot','Private label','0.123456','targetId'])expect(html).not.toContain(privateValue);expect(html).not.toContain('<button');
});
it.each(['bundle','profile','role','range','summary','duplicate','unsupported','backend'])('rejects incoherent v2 %s instead of trusting a capability claim',kind=>{
 const p:any=payload();if(kind==='bundle')p.bundleId='com.random.app';if(kind==='profile')p.extendedTargets[0].profile='arbitrary';if(kind==='role')p.extendedTargets[0].role='AXButton';if(kind==='range')p.extendedTargets[0].scroll.max=-1;if(kind==='summary')p.capabilitiesV2.observedActions=['drag'];if(kind==='duplicate')p.extendedTargets.push(p.extendedTargets[0]);if(kind==='unsupported')p.capabilitiesV2.unsupportedActions=[];if(kind==='backend')p.capabilitiesV2.backend='arbitrary';expect(parseBackgroundCapabilities(call(p))).toBeNull();
});
it('requires a real same-window popup owner for a menu item capability',()=>{
 const p:any=payload();p.bundleId='org.scope.fixture';p.app='Scope Fixture';p.extendedTargets=[{ref:1,role:'AXPopUpButton',label:'mode',profile:'scope-fixture-v1',actions:['menu-open'],menu:{kind:'popup',binding:'window-descendant',ownerRef:1}},{ref:2,role:'AXMenuItem',label:'blue',profile:'scope-fixture-v1',actions:['menu-select'],menu:{kind:'item',binding:'window-descendant',ownerRef:1}}];p.capabilitiesV2.observedActions=['menu-open','menu-select'];p.capabilitiesV2.unsupportedActions=['press','set-value','scroll-position','drag'];expect(parseBackgroundCapabilities(call(p))?.observedActions).toEqual(['menu-open','menu-select']);p.extendedTargets[1].menu.ownerRef=10;expect(parseBackgroundCapabilities(call(p))).toBeNull();
});

it.each(['process','cross-ref','enabled'])('rejects v2 metadata inconsistent with native identity %s',kind=>{const p:any=payload();if(kind==='process')p.processStartedAt=0;if(kind==='cross-ref')p.targets=[{ref:2,role:'AXTextArea',label:'text',backgroundActions:[]}];if(kind==='enabled')p.extendedTargets[0].enabled='yes';expect(parseBackgroundCapabilities(call(p))).toBeNull();});
it('projects slider drag only from coherent measured native slider metadata',()=>{
 const p:any=payload();p.bundleId='org.scope.sliderfixture';p.app='Scope Slider Fixture';p.targets=[];
 p.extendedTargets=[{ref:7,role:'AXSlider',label:'Fixture level',profile:'scope-fixture-slider-v1',actions:['drag'],drag:{kind:'slider',current:25,min:0,max:100,axis:'horizontal',valueTolerance:100/380,geometry:{x:0,y:0,width:402,height:34,thumbX:96,thumbY:9,thumbWidth:20,thumbHeight:16}}}];
 p.capabilitiesV2.observedActions=['drag'];p.capabilitiesV2.unsupportedActions=['press','set-value','scroll-position','menu-open','menu-select'];
 expect(parseBackgroundCapabilities(call(p))?.observedActions).toEqual(['drag']);
 const card=renderToStaticMarkup(<BackgroundCapabilitiesCard capabilities={parseBackgroundCapabilities(call(p))!}/>);expect(card).toContain(t('backgroundCapabilities.actions.sliderDrag'));expect(card).not.toContain('Fixture level');
 for(const mutate of [(q:any)=>q.bundleId='com.arbitrary.app',(q:any)=>q.app='Other app',(q:any)=>q.extendedTargets[0].role='AXGroup',(q:any)=>q.extendedTargets[0].drag.kind='file-drop',(q:any)=>q.extendedTargets[0].drag.current=101,(q:any)=>q.extendedTargets[0].drag.min=100,(q:any)=>q.extendedTargets[0].drag.axis='arbitrary',(q:any)=>q.extendedTargets[0].actions.push('menu-open'),(q:any)=>q.extendedTargets[0].drag.valueTolerance=100,(q:any)=>delete q.extendedTargets[0].drag.geometry,(q:any)=>q.extendedTargets[0].drag.geometry.thumbX=500,(q:any)=>q.extendedTargets[0].drag.axis='vertical',(q:any)=>q.extendedTargets[0].drag.geometry.thumbY=2]){const q=structuredClone(p);mutate(q);expect(parseBackgroundCapabilities(call(q))).toBeNull();}
});
