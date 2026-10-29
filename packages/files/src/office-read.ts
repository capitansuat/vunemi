import {execFile} from 'node:child_process';
import {statSync} from 'node:fs';
import {posix} from 'node:path';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const LIMIT=120_000, PART_LIMIT=2_000_000, TOTAL_LIMIT=12_000_000;
interface X {name:string;attrs:Record<string,string>;children:X[];text:string}
const local=(name:string)=>name.split(':').at(-1)!;
function decode(s:string):string {
 if(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(s))throw new Error('Unknown XML entity');
 return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,v:string)=>{
  if(v[0]!== '#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[v]!);
  const code=v[1]?.toLowerCase()==='x'?parseInt(v.slice(2),16):parseInt(v.slice(1),10);
  if(code===0||code>0x10ffff||(code>=0xd800&&code<=0xdfff))throw new Error('Invalid XML character');
  return String.fromCodePoint(code);
 });
}
/** A bounded non-resolving XML reader. Reject declarations rather than resolving entities. */
function xml(source:string):X {
 if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('Unsafe XML declaration');
 const root:X={name:'root',attrs:{},children:[],text:''},stack=[root];let cursor=0,nodes=0;
 const tokens=source.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g);
 for(const match of tokens){if(match.index!==cursor)throw new Error('Malformed XML');const token=match[0];cursor+=token.length;
  if(token.startsWith('<!--')||token.startsWith('<?'))continue;
  if(token.startsWith('<![CDATA[')){stack.at(-1)!.text+=token.slice(9,-3);continue;}
  if(token.startsWith('</')){if(stack.length<2||stack.at(-1)!.name!==token.slice(2,-1).trim())throw new Error('Malformed XML closing tag');stack.pop();continue;}
  if(token.startsWith('<')){const m=/^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(token);if(!m)throw new Error('Malformed XML tag');const attrs:Record<string,string>={};let rest=m[2]!;while(rest.trim()){const a=/^\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);if(!a)throw new Error('Malformed XML attributes');if(a[1]! in attrs)throw new Error('Duplicate XML attribute');attrs[a[1]!]=decode(a[2]??a[3]??'');rest=rest.slice(a[0].length)}const node:X={name:m[1]!,attrs,children:[],text:''};stack.at(-1)!.children.push(node);if(++nodes>100_000||stack.length>64)throw new Error('XML structure exceeds limit');if(!m[3])stack.push(node);
  }else {if(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(token))throw new Error('Unknown XML entity');stack.at(-1)!.text+=decode(token);}
 }
 if(cursor!==source.length||stack.length!==1||root.children.length!==1||root.text.trim())throw new Error('Malformed XML document');return root.children[0]!;
}
const children=(n:X,name:string)=>n.children.filter(c=>local(c.name)===name);
function descendants(n:X,name:string):X[]{return n.children.flatMap(c=>[...(local(c.name)===name?[c]:[]),...descendants(c,name)])}
const text=(n:X):string=>n.text+n.children.map(text).join('');
const requireRoot=(n:X,name:string)=>{if(local(n.name)!==name)throw new Error(`Expected ${name} XML`);return n};
/** Actual archive read: no extraction, macros, external relationships or formula evaluation. */
export async function readOffice(path:string,extension:string,signal?:AbortSignal):Promise<string>{
 if(statSync(path).size>24_000_000)throw new Error('Office archive exceeds size limit');
 const deadline=Date.now()+30_000;
 const options={timeout:10_000,maxBuffer:PART_LIMIT,encoding:'utf8' as const,signal};
 const {stdout:listing}=await exec('/usr/bin/unzip',['-Z1',path],options);
 const names=listing.trimEnd().split('\n');if(names.length>1500||new Set(names).size!==names.length||names.some(n=>!n||n.startsWith('/')||n.includes('\\')||n.split('/').includes('..')||/[\x00-\x1f*?]/.test(n)))throw new Error('Unsafe or excessive Office archive entries');
 let total=0;const cache=new Map<string,X>();
 const part=async(name:string)=>{if(/[\[\]*?]/.test(name))throw new Error('Unsafe Office part name');if(cache.has(name))return cache.get(name)!;if(!names.includes(name))throw new Error(`Missing Office part: ${name}`);if(Date.now()>=deadline)throw new Error('Office read timeout');const {stdout}=await exec('/usr/bin/unzip',['-p',path,name],{...options,timeout:Math.min(10_000,deadline-Date.now())});total+=Buffer.byteLength(stdout);if(total>TOTAL_LIMIT)throw new Error('Office XML exceeds read limit');if(stdout.includes('\uFFFD'))throw new Error('Invalid Office XML encoding');const parsed=xml(stdout);cache.set(name,parsed);return parsed};
 const rels=async(owner:string)=>{const p=posix.join(posix.dirname(owner),'_rels',posix.basename(owner)+'.rels');const doc=requireRoot(await part(p),'Relationships');const map=new Map<string,string>();for(const r of children(doc,'Relationship')){const id=r.attrs.Id,target=r.attrs.Target;if(!id||!target||map.has(id))throw new Error('Invalid Office relationship');if(r.attrs.TargetMode==='External'){map.set(id,'EXTERNAL');continue}if(target.includes('\\')||target.includes(':')||target.includes('#')||target.includes('?'))throw new Error('Unsafe Office relationship');const resolved=target.startsWith('/')?target.slice(1):posix.normalize(posix.join(posix.dirname(owner),target));if(resolved.startsWith('../')||!names.includes(resolved))throw new Error('Missing Office relationship target');map.set(id,resolved)}return map};
 // A sheet's charts, so a check of a workbook can see that a requested chart is there and what it shows.
 const charts=async(ws:X,sheet:string):Promise<string[]>=>{
  const drawing=children(ws,'drawing')[0]?.attrs['r:id'];if(!drawing)return [];
  const d=(await rels(sheet)).get(drawing);if(!d||!d.startsWith('xl/drawings/'))throw new Error('Invalid sheet drawing relationship');
  const chartRels=await rels(d),found:string[]=[];
  for(const ref of descendants(await part(d),'chart')){
   const c=chartRels.get(ref.attrs['r:id']??'');if(!c||!c.startsWith('xl/charts/'))throw new Error('Invalid chart relationship');
   const space=requireRoot(await part(c),'chartSpace'),chart=children(space,'chart')[0],plot=chart&&children(chart,'plotArea')[0];if(!plot)throw new Error('Chart has no plot area');
   const title=children(chart,'title')[0],named=title?descendants(title,'t').map(text).join('').trim():'';
   for(const kind of plot.children.filter(k=>local(k.name).endsWith('Chart'))){
    const bar=children(kind,'barDir')[0]?.attrs.val,name=local(kind.name).replace(/(3D)?Chart$/,'');
    const ref=(n:X|undefined)=>n?descendants(n,'f').map(text).join(',')||descendants(n,'v').map(text).join(','):'';
    const series=children(kind,'ser').map(ser=>`series ${ref(children(ser,'tx')[0])||'(unnamed)'}: values ${ref(children(ser,'val')[0]??children(ser,'yVal')[0])||'none'}${ref(children(ser,'cat')[0]??children(ser,'xVal')[0])?`, categories ${ref(children(ser,'cat')[0]??children(ser,'xVal')[0])}`:''}`);
    found.push(`Chart: ${name==='bar'&&bar==='col'?'column':name}${named?` ${JSON.stringify(named)}`:''}${series.length?`; ${series.join('; ')}`:'; no series'}`);
   }
  }
  return found;
 };
 const lines:string[]=[];let length=0;const add=(line:string)=>{length+=line.length+1;if(length>LIMIT)throw new Error('Office text exceeds complete read limit');lines.push(line)};
 if(extension==='.xlsx'){
  const owner='xl/workbook.xml',book=requireRoot(await part(owner),'workbook'),relations=await rels(owner),sheets=descendants(book,'sheet');if(!sheets.length)throw new Error('Workbook has no sheets');
  const shared=names.includes('xl/sharedStrings.xml')?children(requireRoot(await part('xl/sharedStrings.xml'),'sst'),'si').map(si=>descendants(si,'t').map(text).join('')):[];
  const used=new Set<string>();for(const sheet of sheets){const target=relations.get(sheet.attrs['r:id']??'');if(!sheet.attrs.name||!target||!target.startsWith('xl/worksheets/')||used.has(target))throw new Error('Invalid worksheet order/relationship');used.add(target);add(`Sheet: ${sheet.attrs.name}`);const ws=requireRoot(await part(target),'worksheet');const cells=new Set<string>();for(const c of descendants(ws,'c')){const address=c.attrs.r;if(!address||!/^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(address)||cells.has(address))throw new Error('Invalid or duplicate cell address');cells.add(address);const values=children(c,'v'),formulas=children(c,'f');if(values.length>1||formulas.length>1)throw new Error('Ambiguous cell contents');let value=values[0]?text(values[0]):'';if(c.attrs.t && !['n','s','inlineStr','b','str','e','d'].includes(c.attrs.t))throw new Error('Unsupported cell type');if((!c.attrs.t||c.attrs.t==='n')&&values[0]&&(!value.trim()||!Number.isFinite(Number(value))))throw new Error('Invalid numeric cell cache');if(c.attrs.t==='b'&&values[0]&&!/^[01]$/.test(value))throw new Error('Invalid Boolean cell cache');if(c.attrs.t==='e')throw new Error(`Spreadsheet error cell ${address}: ${value}`);if(c.attrs.t==='s'){if(!/^\d+$/.test(value)||shared[Number(value)]===undefined)throw new Error('Invalid shared string reference');value=shared[Number(value)]!}if(c.attrs.t==='inlineStr')value=descendants(c,'t').map(text).join('');if(formulas[0]){if(!text(formulas[0])||!values[0]||value==='')throw new Error(`Incomplete formula cache: ${address}`);add(`${address}: formula=${text(formulas[0])}; cached=${value}`)}else add(`${address}: ${value}`)}for(const line of await charts(ws,target))add(line);}
 }else if(extension==='.pptx'){
  const owner='ppt/presentation.xml',presentation=requireRoot(await part(owner),'presentation'),relations=await rels(owner),slides=descendants(presentation,'sldId');if(!slides.length)throw new Error('Presentation has no slides');const used=new Set<string>();let i=0;for(const slide of slides){const target=relations.get(slide.attrs['r:id']??'');if(!target||!target.startsWith('ppt/slides/')||used.has(target))throw new Error('Invalid slide order/relationship');used.add(target);const document=requireRoot(await part(target),'sld');add(`Slide ${++i}`);for(const p of descendants(document,'p')){const content=descendants(p,'t').map(text).join('');if(content)add(content)}const relName=posix.join(posix.dirname(target),'_rels',posix.basename(target)+'.rels');if(names.includes(relName)){const slideRels=await rels(target);for(const note of slideRels.values())if(note.startsWith('ppt/notesSlides/')){add('Notes:');const doc=requireRoot(await part(note),'notes');for(const p of descendants(doc,'p')){const content=descendants(p,'t').map(text).join('');if(content)add(content)}}}}
 }else throw new Error('Unsupported Office read format');
 return lines.join('\n');
}
