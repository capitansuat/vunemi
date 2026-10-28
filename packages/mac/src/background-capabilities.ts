/** A display projection of one native observation, never authority to dispatch input. */
export interface BackgroundCapabilities {
 version:1;
 controlMode:'backgroundStrict';
 status:'observed'|'no-actions-observed';
 observedActions:('press'|'set-value')[];
 unsupportedActions:['menu','scroll','drag'];
 reasonCode:'eligible-targets-observed'|'no-eligible-targets-observed';
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function backgroundCapabilities(value:unknown):BackgroundCapabilities|null {
 if(!record(value)||value.controlMode!=='backgroundStrict'||typeof value.snapshotId!=='string'||!value.snapshotId.trim()||value.snapshotId.length>200||!Number.isSafeInteger(value.windowId)||Number(value.windowId)<=0||typeof value.bundleId!=='string'||!value.bundleId||value.bundleId.length>200||!Array.isArray(value.targets)||value.targets.length>4096)return null;
 const observed=new Set<'press'|'set-value'>(),refs=new Set<number>();
 for(const target of value.targets){
  if(!record(target)||!Number.isSafeInteger(target.ref)||Number(target.ref)<=0||refs.has(Number(target.ref))||typeof target.role!=='string'||typeof target.label!=='string'||!Array.isArray(target.backgroundActions)||target.backgroundActions.some(action=>action!=='press'&&action!=='set-value')||(target.subrole!==undefined&&typeof target.subrole!=='string')||(target.enabled!==undefined&&typeof target.enabled!=='boolean'))return null;
  refs.add(Number(target.ref));
  if(target.enabled===false||target.subrole)continue;
  if(value.bundleId==='com.apple.calculator'&&target.role==='AXButton'&&target.backgroundActions.includes('press'))observed.add('press');
  if(value.bundleId==='com.apple.TextEdit'&&target.role==='AXTextArea'&&target.backgroundActions.includes('set-value'))observed.add('set-value');
 }
 const observedActions=(['press','set-value'] as const).filter(action=>observed.has(action));
 return {version:1,controlMode:'backgroundStrict',status:observedActions.length?'observed':'no-actions-observed',observedActions,unsupportedActions:['menu','scroll','drag'],reasonCode:observedActions.length?'eligible-targets-observed':'no-eligible-targets-observed'};
}

export const BACKGROUND_ACTIONS_V2=['press','set-value','scroll-position','menu-open','menu-select','drag'] as const;
export type BackgroundActionV2=typeof BACKGROUND_ACTIONS_V2[number];
export interface ExtendedNativeTarget {ref:number;role:string;label:string;profile:'textedit-scroll-v1'|'scope-fixture-v1'|'scope-fixture-slider-v1';actions:('scroll-position'|'menu-open'|'menu-select'|'drag')[];drag?:SliderDragMetadata;scroll?:{current:number;min:number;max:number;axis:'vertical'|'horizontal'};menu?:{kind:'popup'|'item';binding:'window-descendant';ownerRef:number};targetId?:string}
export interface BackgroundCapabilitiesV2 {version:2;backend:'native-ax';controlMode:'backgroundStrict';status:'observed'|'no-actions-observed';observedActions:BackgroundActionV2[];unsupportedActions:BackgroundActionV2[];reasonCode:'eligible-targets-observed'|'no-eligible-targets-observed'}
export function backgroundCapabilitiesV2(value:unknown):BackgroundCapabilitiesV2|null {
 const legacy=backgroundCapabilities(value);if(!legacy||!record(value)||!Number.isSafeInteger(value.pid)||Number(value.pid)<=0||typeof value.processStartedAt!=='number'||!Number.isFinite(value.processStartedAt)||value.processStartedAt<=0||!Array.isArray(value.extendedTargets)||value.extendedTargets.length>4096)return null;
 const observed=new Set<BackgroundActionV2>(legacy.observedActions),refs=new Map<number,Record<string,unknown>>();
 for(const t of value.extendedTargets){
  if(!record(t)||!Number.isSafeInteger(t.ref)||Number(t.ref)<=0||refs.has(Number(t.ref))||(value.targets as Record<string,unknown>[]).some(old=>old.ref===t.ref)||typeof t.role!=='string'||typeof t.label!=='string'||t.enabled===false||(t.enabled!==undefined&&typeof t.enabled!=='boolean')||t.subrole!==undefined&&t.subrole!==''||!Array.isArray(t.actions)||!t.actions.length||new Set(t.actions).size!==t.actions.length)return null;
  const slider=t.profile==='scope-fixture-slider-v1'&&value.bundleId==='org.scope.sliderfixture'&&value.app==='Scope Slider Fixture';
  const fixture=t.profile==='scope-fixture-v1'&&value.bundleId==='org.scope.fixture'&&value.app==='Scope Fixture',textedit=t.profile==='textedit-scroll-v1'&&value.bundleId==='com.apple.TextEdit';
  if(!fixture&&!textedit&&!slider)return null;
  for(const action of t.actions){
   if(action==='drag'){if(!slider||t.role!=='AXSlider'||t.actions.length!==1||!validSliderDrag(t.drag))return null;
   }else if(action==='scroll-position'){if(slider)return null;
    const s=t.scroll;if(t.role!=='AXScrollBar'||!record(s)||!['vertical','horizontal'].includes(String(s.axis))||![s.current,s.min,s.max].every(n=>typeof n==='number'&&Number.isFinite(n))||Number(s.min)>=Number(s.max)||Number(s.current)<Number(s.min)||Number(s.current)>Number(s.max))return null;
   }else if(action==='menu-open'||action==='menu-select'){
    const m=t.menu;if(!fixture||!record(m)||m.binding!=='window-descendant'||!Number.isSafeInteger(m.ownerRef)||Number(m.ownerRef)<=0||t.role!==(action==='menu-open'?'AXPopUpButton':'AXMenuItem')||m.kind!==(action==='menu-open'?'popup':'item')||action==='menu-open'&&m.ownerRef!==t.ref)return null;
   }else return null;
   observed.add(action);
  }
  refs.set(Number(t.ref),t);
 }
 for(const t of refs.values())if((t.actions as string[]).includes('menu-select')){const owner=refs.get(Number((t.menu as Record<string,unknown>).ownerRef));if(!owner||(owner.actions as string[]).includes('menu-open')!==true)return null;}
 const observedActions=BACKGROUND_ACTIONS_V2.filter(a=>observed.has(a)),unsupportedActions=BACKGROUND_ACTIONS_V2.filter(a=>!observed.has(a));
 return {version:2,backend:'native-ax',controlMode:'backgroundStrict',status:observedActions.length?'observed':'no-actions-observed',observedActions,unsupportedActions,reasonCode:observedActions.length?'eligible-targets-observed':'no-eligible-targets-observed'};
}

export interface SliderDragMetadata {kind:'slider';current:number;min:number;max:number;axis:'horizontal';valueTolerance:number;geometry:{x:number;y:number;width:number;height:number;thumbX:number;thumbY:number;thumbWidth:number;thumbHeight:number}}
export function validSliderDrag(value:unknown):value is SliderDragMetadata {
 if(!record(value)||value.kind!=='slider'||value.axis!=='horizontal'||![value.current,value.min,value.max,value.valueTolerance].every(n=>typeof n==='number'&&Number.isFinite(n))||Number(value.min)>=Number(value.max)||Number(value.current)<Number(value.min)||Number(value.current)>Number(value.max)||!record(value.geometry))return false;
 const g=value.geometry,keys=['x','y','width','height','thumbX','thumbY','thumbWidth','thumbHeight'];if(!keys.every(k=>typeof g[k]==='number'&&Number.isFinite(g[k])))return false;
 const width=Number(g.width),height=Number(g.height),tw=Number(g.thumbWidth),th=Number(g.thumbHeight),travel=width-tw-2,range=Number(value.max)-Number(value.min);
 if(width<40||width>2000||height<=0||tw<4||tw>100||th<=0||travel<20||th>height||Math.abs(Number(g.thumbY)+th/2-(Number(g.y)+height/2))>0.5||Number(g.thumbX)<Number(g.x)||Number(g.thumbX)+tw>Number(g.x)+width||Number(g.thumbY)<Number(g.y)||Number(g.thumbY)+th>Number(g.y)+height)return false;
 return Number(value.valueTolerance)>0&&Number(value.valueTolerance)<=range/travel+1e-9&&Math.abs(Number(g.thumbX)-(Number(g.x)+1+(Number(value.current)-Number(value.min))/range*travel))<=0.5;
}
