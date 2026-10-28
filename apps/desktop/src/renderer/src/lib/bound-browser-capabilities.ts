import type {CallView} from './fold.js';
import type {BackgroundCapabilityView} from './background-capabilities.js';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=200;
/** Only a structured observation from the bound tool, never prose or a grant. */
export function parseBoundBrowserCapabilities(call:Pick<CallView,'tool'|'status'|'output'>):BackgroundCapabilityView|null {
 if(call.tool!=='page_target_observe'||call.status!=='ok'||!call.output||call.output.length>200_000)return null;
 let raw=call.output.trim();const fence=/^<untrusted_content source="page_target_observe">\n([\s\S]*)\n<\/untrusted_content>$/.exec(raw);if(fence)raw=fence[1]!;
 let value:unknown;try{value=JSON.parse(raw);}catch{return null;}
 if(!object(value)||value.kind!=='bound-browser-observation'||value.version!==1||value.controlMode!=='backgroundStrict'||value.observationOnly!==true||typeof value.screenshotObserved!=='boolean'||!['managed-browser','owned-web-content'].includes(String(value.backend))||![value.bindingId,value.snapshotId,value.targetId,value.frameId,value.loaderId].every(id)||value.bindingId!==value.snapshotId||(value.title!==null&&(typeof value.title!=='string'||value.title.length>2000))||typeof value.origin!=='string'||typeof value.url!=='string'||value.url.length>20_000||![value.width,value.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>1&&n<=32768)||typeof value.scale!=='number'||!Number.isFinite(value.scale)||value.scale<=0||value.scale>16)return null;
 try{const url=new URL(value.url),origin=new URL(value.origin);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||origin.origin!==value.origin||url.origin!==origin.origin)return null;}catch{return null;}
 return {backend:value.backend as 'managed-browser'|'owned-web-content',targetKind:'page',actionAvailability:'per-action',app:value.origin,bundleId:value.origin,windowId:0,windowTitle:typeof value.title==='string'&&value.title.trim()?value.title.trim():null,observedActions:[],unsupportedActions:[]};
}
