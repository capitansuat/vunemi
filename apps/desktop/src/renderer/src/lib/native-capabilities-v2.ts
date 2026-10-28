/** Display validation only: a capability summary never grants an action. */
export const nativeActions=['press','set-value','scroll-position','menu-open','menu-select','drag'] as const;
export type NativeAction=typeof nativeActions[number];
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:readonly unknown[])=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
export function nativeV2Projection(value:Record<string,unknown>,legacy:readonly NativeAction[]){
 const summary=value.capabilitiesV2;
 if(!Number.isSafeInteger(value.pid)||Number(value.pid)<=0||typeof value.processStartedAt!=='number'||!Number.isFinite(value.processStartedAt)||value.processStartedAt<=0||!object(summary)||summary.version!==2||summary.backend!=='native-ax'||summary.controlMode!=='backgroundStrict'||!Array.isArray(value.extendedTargets)||value.extendedTargets.length>4096)return null;
 const observed=new Set<NativeAction>(legacy),targets=new Map<number,Record<string,unknown>>();
 for(const target of value.extendedTargets){
  if(!object(target)||!Number.isSafeInteger(target.ref)||Number(target.ref)<=0||targets.has(Number(target.ref))||(value.targets as Record<string,unknown>[]).some(old=>old.ref===target.ref)||typeof target.role!=='string'||typeof target.label!=='string'||target.enabled===false||(target.enabled!==undefined&&typeof target.enabled!=='boolean')||(target.subrole!==undefined&&target.subrole!=='')||!Array.isArray(target.actions)||!target.actions.length||new Set(target.actions).size!==target.actions.length)return null;
  const fixture=target.profile==='scope-fixture-v1'&&value.bundleId==='org.scope.fixture'&&value.app==='Scope Fixture';
  const textedit=target.profile==='textedit-scroll-v1'&&value.bundleId==='com.apple.TextEdit';
  const slider=target.profile==='scope-fixture-slider-v1'&&value.bundleId==='org.scope.sliderfixture'&&value.app==='Scope Slider Fixture';
  if(!fixture&&!textedit&&!slider)return null;
  for(const action of target.actions){
   if(slider&&action!=='drag')return null;
   if(action==='drag'){
    const drag=target.drag;if(!slider||target.role!=='AXSlider'||!object(drag)||drag.kind!=='slider'||drag.axis!=='horizontal'||![drag.current,drag.min,drag.max].every(n=>typeof n==='number'&&Number.isFinite(n))||Number(drag.min)>=Number(drag.max)||Number(drag.current)<Number(drag.min)||Number(drag.current)>Number(drag.max)||typeof drag.valueTolerance!=='number'||!Number.isFinite(drag.valueTolerance)||drag.valueTolerance<=0||!object(drag.geometry))return null;
    const g=drag.geometry;if(!['x','y','width','height','thumbX','thumbY','thumbWidth','thumbHeight'].every(k=>typeof g[k]==='number'&&Number.isFinite(g[k])))return null;
    const width=Number(g.width),height=Number(g.height),tw=Number(g.thumbWidth),th=Number(g.thumbHeight),travel=width-tw-2,range=Number(drag.max)-Number(drag.min);
    if(width<40||width>2000||height<=0||tw<4||tw>100||th<=0||travel<20||th>height||Number(g.thumbY)<Number(g.y)||Number(g.thumbY)+th>Number(g.y)+height||Math.abs((Number(g.thumbY)+th/2)-(Number(g.y)+height/2))>0.5||drag.valueTolerance>range/travel+1e-9||Math.abs(Number(g.thumbX)-(Number(g.x)+1+(Number(drag.current)-Number(drag.min))/range*travel))>0.5)return null;
   }else if(action==='scroll-position'){
    const s=target.scroll;if(target.role!=='AXScrollBar'||!object(s)||!['vertical','horizontal'].includes(String(s.axis))||![s.current,s.min,s.max].every(n=>typeof n==='number'&&Number.isFinite(n))||Number(s.min)>=Number(s.max)||Number(s.current)<Number(s.min)||Number(s.current)>Number(s.max))return null;
   }else if(action==='menu-open'||action==='menu-select'){
    const menu=target.menu;if(!fixture||!object(menu)||menu.binding!=='window-descendant'||!Number.isSafeInteger(menu.ownerRef)||Number(menu.ownerRef)<=0||target.role!==(action==='menu-open'?'AXPopUpButton':'AXMenuItem')||menu.kind!==(action==='menu-open'?'popup':'item')||(action==='menu-open'&&menu.ownerRef!==target.ref))return null;
   }else return null;
   observed.add(action);
  }
  targets.set(Number(target.ref),target);
 }
 for(const target of targets.values())if((target.actions as string[]).includes('menu-select')){const owner=targets.get(Number((target.menu as Record<string,unknown>).ownerRef));if(!owner||!(owner.actions as string[]).includes('menu-open'))return null;}
 const observedActions=nativeActions.filter(action=>observed.has(action)),unsupportedActions=nativeActions.filter(action=>!observed.has(action));
 if(!same(summary.observedActions,observedActions)||!same(summary.unsupportedActions,unsupportedActions)||summary.status!==(observedActions.length?'observed':'no-actions-observed')||summary.reasonCode!==(observedActions.length?'eligible-targets-observed':'no-eligible-targets-observed'))return null;
 return {backend:'native-ax' as const,observedActions,unsupportedActions};
}
