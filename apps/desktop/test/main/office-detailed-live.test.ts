/** Opt-in installed Craft quality acceptance. No generated output is treated as verified until independently read. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Roots,createFileTools} from '@vunemi/files';
import type {ToolContext} from '@vunemi/agent-core';
import {ADDONS,type AddonId} from '../../src/main/addons/catalog.js';
import {createEngines} from '../../src/main/addons/jobs.js';
import {fullAccessTools} from '../../src/main/addons/tools/full-access.js';
const installed = process.env.CRAFT_ADDONS_DIR ?? join(homedir(), 'Library/Application Support/Vunemi/addons');
const program=(id:AddonId)=>{const a=ADDONS.find(a=>a.id===id)!;return join(installed,id,a.tag,a.folder,a.binary)};
const ctx=():ToolContext=>({signal:new AbortController().signal,handoff:async()=>true,offerUndo:()=>{},attach:()=>{}});
const cmd=(id:string,params:Record<string,unknown>)=>['--cmd',`${id}=${JSON.stringify(params)}`];
let base:string,evidence:string;const records:unknown[]=[];
const input=(name:string)=>[{name,path:join(base,name)}];
const output=input;
async function run(id:AddonId,label:string,args:string[],extra:Record<string,unknown>={}){
 const addon=ADDONS.find(a=>a.id===id)!;
 const engines=createEngines({home:homedir(),jobsDir:join(base,'jobs'),addons:{binary:id=>existsSync(program(id))?program(id):null,engineDir:id=>join(installed,id,ADDONS.find(a=>a.id===id)!.tag)}});
 const tools=fullAccessTools(id,addon.engine,'quality fixture',{roots:new Roots([base]),shotDir:base,backupDir:join(base,'.backups'),engines});
 try{const result=String(await tools[1]!.run({args,...extra},ctx()));writeFileSync(join(evidence,`${label}.txt`),result);records.push({id,label,args,ok:true,output:result});for(const file of (extra.outputs??[])as {name:string;path:string}[]){if(existsSync(file.path)){copyFileSync(file.path,join(evidence,file.name));records.push({file:file.name,sha256:createHash('sha256').update(readFileSync(file.path)).digest('hex')})}}return result}
 catch(error){records.push({id,label,args,ok:false,error:String(error)});throw error}
}
function xml(file:string,part:string){const value=execFileSync('/usr/bin/unzip',['-p',join(base,file),part],{encoding:'utf8',timeout:10000,maxBuffer:2000000});writeFileSync(join(evidence,`${file}-${part.replaceAll('/','_')}.xml`),value);return value}
async function independentRead(name:string,contains:string[]){const reader=createFileTools({roots:new Roots([base]),shadowDir:join(base,'shadows')}).find(t=>t.name==='files_read')!;const result=String(await reader.run({path:join(base,name),checks:{contains,nonempty:true}},ctx()));writeFileSync(join(evidence,`${name}-independent-read.txt`),result);return result}
describe.skipIf(process.env.CRAFT_LIVE!=='1'||process.platform!=='darwin')('Office detailed installed engine acceptance',()=>{
 beforeAll(()=>{base=realpathSync(mkdtempSync(join(tmpdir(),'vunemi-office-quality-')));evidence=resolve('../../research/office-acceptance-2026-10-15/advanced',new Date().toISOString().replaceAll(':','-'));mkdirSync(evidence,{recursive:true});for(const id of ['documents','slides']as const)if(!existsSync(program(id)))throw new Error(`Required pinned engine unavailable: ${id}`)});
 afterAll(()=>{if(!evidence)return;writeFileSync(join(evidence,'summary.json'),JSON.stringify({time:new Date().toISOString(),method:'production fullAccessTools/createEngines sandbox; independent files_read/OOXML/PNG',engines:['documents','slides'].map(id=>({id,path:program(id as AddonId),sha256:existsSync(program(id as AddonId))?createHash('sha256').update(readFileSync(program(id as AddonId))).digest('hex'):null})),records},null,2));rmSync(base,{recursive:true,force:true})});
 it('Word replaces a single occurrence and preserves adjacent bold/plain runs',async()=>{
  const registry=await run('documents','word-command-registry',['commands','--json']);expect(registry).toContain('edit.replace');expect(registry).toContain('select.text');
  await run('documents','word-source',['convert','source.md','source.docx'],{files:[{name:'source.md',text:'Before **BOLD** budget 100 and budget 100 after.\n'}],outputs:output('source.docx')});
  await run('documents','word-one-replace',['run','--file','source.docx',...cmd('select.text',{text:'100',occurrence:1}),...cmd('edit.replace',{text:'100',with:'200'}),'--save','single.docx'],{inputs:input('source.docx'),outputs:output('single.docx')});
  const body=xml('single.docx','word/document.xml');const visible=[...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>m[1]).join('');expect(visible.match(/100/g)).toHaveLength(1);expect(visible.match(/200/g)).toHaveLength(1);
  const runs=[...body.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map(m=>m[0]);expect(runs.some(r=>r.includes('BOLD')&&/<w:b(?:\s|\/|>)/.test(r))).toBe(true);expect(runs.some(r=>r.includes('Before')&&!/<w:b(?:\s|\/|>)/.test(r))).toBe(true);
  await independentRead('single.docx',['BOLD','budget 200','budget 100']);
 },120000);
 it('Word preserves multilingual text and produces a nonempty real PNG preview',async()=>{
  await run('documents','word-unicode-create',['convert','unicode.md','unicode.docx'],{files:[{name:'unicode.md',text:'# Çok dilli rapor\n\nİstanbul, öğrenciler, şeffaflık. Ελληνικά: Καλημέρα. 日本語: こんにちは。 العربية: مرحبا.\n\nAmount 40; no currency inferred.\n'}],outputs:output('unicode.docx')});
  await independentRead('unicode.docx',['İstanbul','Καλημέρα','こんにちは','مرحبا','Amount 40']);
  await run('documents','word-unicode-render',['render','unicode.docx','unicode.png','--page','1','--scale','1'],{inputs:input('unicode.docx'),outputs:output('unicode.png')});
  const png=readFileSync(join(base,'unicode.png'));expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(png.readUInt32BE(16)).toBeGreaterThan(100);expect(png.readUInt32BE(20)).toBeGreaterThan(100);expect(png.length).toBeGreaterThan(3000);
 },120000);
 it('Deck persists two ordered slides and separate speaker notes in independent readback',async()=>{
  await run('slides','deck-notes-describe',['describe','slide.notes']);await run('slides','deck-slide-describe',['describe','slide.new']);
  await run('slides','deck-two-slides',['run',...cmd('file.new',{blank:true}),...cmd('slide.new',{layout:'titleAndContent',title:'First review',body:'Revenue 40'}),...cmd('slide.notes',{index:0,text:'First speaker note 40.'}),...cmd('slide.new',{layout:'titleAndContent',title:'Second review',body:'Cost 20'}),...cmd('slide.notes',{index:1,text:'Second speaker note 20.'}),'--save','ordered.pptx'],{outputs:output('ordered.pptx')});
  const read=await independentRead('ordered.pptx',['First review','Second review','First speaker note 40.','Second speaker note 20.']);expect(read.indexOf('First review')).toBeLessThan(read.indexOf('Second review'));expect(read).toContain('Slide 2');expect(read).not.toContain('Slide 3');
  expect(xml('ordered.pptx','ppt/notesSlides/notesSlide1.xml')).toContain('First speaker note 40.');expect(xml('ordered.pptx','ppt/notesSlides/notesSlide2.xml')).toContain('Second speaker note 20.');
 },120000);
});
