/** Adapter-owned independent readback. Model prose and transport acknowledgements are never receipts. */
export interface OutcomeEvidence {
 version:1;
 domain:'browser'|'calendar'|'mail-draft';
 kind:'navigation'|'field-value'|'event-created'|'event-updated'|'draft-saved';
 targetId:string;
 requestHash:string;
 observedHash:string;
 source:'controller-readback';
}
const tools:Record<string,readonly OutcomeEvidence['kind'][]>={page_goto:['navigation'],page_type:['field-value'],page_select:['field-value'],calendar_create:['event-created'],calendar_update:['event-updated'],mail_draft:['draft-saved']};
export function validOutcomeEvidence(e:unknown,tool?:string):e is OutcomeEvidence {
 if(!e||typeof e!=='object'||Array.isArray(e))return false;
 const x=e as OutcomeEvidence;
 if(Object.keys(x).sort().join(',')!=='domain,kind,observedHash,requestHash,source,targetId,version'||x.version!==1||x.source!=='controller-readback'||typeof x.targetId!=='string'||!x.targetId.length||x.targetId.length>2048||typeof x.requestHash!=='string'||typeof x.observedHash!=='string'||!(/^[a-f0-9]{64}$/.test(x.requestHash))||x.requestHash!==x.observedHash)return false;
 const domain=x.kind==='navigation'||x.kind==='field-value'?'browser':x.kind==='draft-saved'?'mail-draft':x.kind==='event-created'||x.kind==='event-updated'?'calendar':null;
 return domain!==null&&x.domain===domain&&(!tool||!!tools[tool]?.includes(x.kind));
}
/** All of these may deliver an input without establishing the user's requested result. */
export function requiresOutcomeEvidence(tool:string):boolean {return !!tools[tool]||['page_click','page_press','page_scroll','page_wait','page_target_act','page_back'].includes(tool);}
export async function outcomeFingerprint(value:unknown):Promise<string>{
 const ordered=(v:unknown):unknown=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,ordered(x)])):v;
 const text=JSON.stringify(ordered(value));if(text===undefined)throw Error('Unserializable outcome');
 const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
/** Stable dispatch identity, including equivalent wire encodings and omitted optional defaults. */
export async function mutationRequestFingerprint(tool:string,args:Record<string,unknown>):Promise<string>{
 const keys=tool==='mail_draft'?['to','cc','subject','body','account','inReplyTo']:tool==='calendar_create'?['title','start','end','allDay','calendar','location','notes']:['id','title','start','end','location','notes'];
 const a=Object.fromEntries(keys.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
 if(tool==='calendar_create'||tool==='calendar_update'){
  if(typeof a.title==='string')a.title=a.title.trim();
  for(const key of ['start','end'])if(typeof a[key]==='string'&&Number.isFinite(Date.parse(a[key] as string)))a[key]=new Date(a[key] as string).toISOString();
  if(tool==='calendar_create'){if(a.end===undefined&&typeof a.start==='string'&&Number.isFinite(Date.parse(a.start)))a.end=new Date(Date.parse(a.start)+3600000).toISOString();a.allDay??=false;for(const key of ['calendar','location','notes'])a[key]??='';}
 }else if(tool==='mail_draft'){
  for(const key of ['to','cc'])a[key]=Array.isArray(a[key])?(a[key] as unknown[]).map(x=>typeof x==='string'?x.trim().toLowerCase():x).filter(x=>x!=='').sort():[];
  for(const key of ['account','inReplyTo'])a[key]??='';
  if(typeof a.body==='string')a.body=a.body.replace(/\r\n/g,'\n');
 }
 return outcomeFingerprint({tool,args:a});
}
