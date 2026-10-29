/** Opt in with CRAFT_LIVE=1. Uses installed pinned programs through production sandbox jobs; CRAFT_ADDONS_DIR points at another add-ons folder. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roots } from '@vunemi/files';
import type { ToolContext } from '@vunemi/agent-core';
import { ADDONS, type AddonId } from '../../src/main/addons/catalog.js';
import { createEngines } from '../../src/main/addons/jobs.js';
import { fullAccessTools } from '../../src/main/addons/tools/full-access.js';
const installed = process.env.CRAFT_ADDONS_DIR ?? join(homedir(), 'Library/Application Support/Vunemi/addons');
const program = (id: AddonId) => { const a = ADDONS.find(a => a.id === id)!; return join(installed,id,a.tag,a.folder,a.binary); };
const evidence = resolve('../../research/craft-full-access-2026-10-14/live');
const ctx = (): ToolContext => ({ signal:new AbortController().signal, handoff:async()=>true, offerUndo:()=>{}, attach:()=>{} });
const cmd = (id:string, params:Record<string,unknown>) => ['--cmd',`${id}=${JSON.stringify(params)}`];
let base:string;
const records:unknown[]=[];
function hashes(file:{name:string;path:string}):unknown[] { return statSync(file.path).isDirectory() ? readdirSync(file.path).flatMap(name=>hashes({name:`${file.name}/${name}`,path:join(file.path,name)})) : [{name:file.name,bytes:readFileSync(file.path).length,sha256:createHash('sha256').update(readFileSync(file.path)).digest('hex')}]; }
async function run(id:AddonId,label:string,args:string[],extra:Record<string,unknown>={}) {
 const a=ADDONS.find(a=>a.id===id)!;
 const engines=createEngines({home:homedir(),jobsDir:join(base,'jobs'),addons:{binary:id=>existsSync(program(id))?program(id):null,engineDir:id=>join(installed,id,ADDONS.find(a=>a.id===id)!.tag)}});
 const tools=fullAccessTools(id,a.engine,'fixture',{roots:new Roots([base]),shotDir:base,engines});
 const params={args,...extra};
 try { const output=String(await (label.endsWith('-help') ? tools[0]!.run({},ctx()) : tools[1]!.run(params,ctx()))); records.push({id,label,args,ok:true,output,exports:(extra.outputs as {name:string;path:string}[]|undefined)?.flatMap(hashes)}); writeFileSync(join(evidence,`${label}.txt`),output); return output; }
 catch(error) { records.push({id,label,args,ok:false,error:String(error)});throw error; }
}
const output=(name:string)=>[{name,path:join(base,name)}];
const input=(name:string)=>[{name,path:join(base,name)}];
const xml=(name:string,entry:string)=>{const text=execFileSync('/usr/bin/unzip',['-p',join(base,name),entry],{encoding:'utf8'});writeFileSync(join(evidence,`${name}-${entry.replaceAll('/','_')}.txt`),text);return text;};
describe.skipIf(process.env.CRAFT_LIVE!=='1' || process.platform!=='darwin')('installed Craft full access (sandboxed)',()=>{
 beforeAll(()=>{base=realpathSync(mkdtempSync(join(tmpdir(),'vunemi-craft-live-')));mkdirSync(evidence,{recursive:true});});
 afterAll(()=>{writeFileSync(join(evidence,'summary.json'),JSON.stringify({time:new Date().toISOString(),sandbox:'production createEngines/runSandboxed',engines:ADDONS.map(a=>({id:a.id,path:program(a.id),present:existsSync(program(a.id)),sha256:existsSync(program(a.id))?createHash('sha256').update(readFileSync(program(a.id))).digest('hex'):null})),records},null,2));rmSync(base,{recursive:true,force:true});});
 for(const a of ADDONS) it.skipIf(!existsSync(program(a.id)))(`${a.engine}: help and full command catalogue`,async()=>{
  expect(await run(a.id,`${a.id}-help`,['--help'])).toMatch(/cli/i);
  const args=a.id==='pdf'?['tools']:['commands',...(['documents','sheets','photo','video'].includes(a.id)?['--json']:[])];
  const registry=await run(a.id,`${a.id}-registry`,args);expect(registry.length).toBeGreaterThan(100);
 },120000);
 it.skipIf(!existsSync(program('sheets')))('Grid: existing workbook recalculation, error checking, pivot, saved readback',async()=>{
  await run('sheets','grid-create',['run',...cmd('cell.set',{cell:'A1',input:'Team'}),...cmd('cell.set',{cell:'B1',input:'Amount'}),...cmd('cell.set',{cell:'A2',input:'A'}),...cmd('cell.set',{cell:'B2',input:'10'}),...cmd('cell.set',{cell:'A3',input:'A'}),...cmd('cell.set',{cell:'B3',input:'20'}),...cmd('cell.set',{cell:'B4',input:'=SUM(B2:B3)'}),'--out','source.xlsx'],{outputs:output('source.xlsx')});
  await run('sheets','grid-recalc',['run','--in','source.xlsx',...cmd('cell.set',{cell:'B2',input:'50'}),...cmd('formulas.calculateNow',{}),...cmd('formulas.errorChecking',{}),'--out','recalculated.xlsx'],{inputs:input('source.xlsx'),outputs:output('recalculated.xlsx')});
  expect(await run('sheets','grid-read',['cat','recalculated.xlsx','--range','A1:B4'],{inputs:input('recalculated.xlsx')})).toContain('70');
  await run('sheets','grid-pivot',['run','--in','recalculated.xlsx',...cmd('insert.pivotTable',{source:'Sheet1!A1:B3',rows:['Team'],values:[{field:'Amount',func:'sum'}]}),'--out','pivot.xlsx'],{inputs:input('recalculated.xlsx'),outputs:output('pivot.xlsx')});
  expect(xml('recalculated.xlsx','xl/worksheets/sheet1.xml')).toContain('SUM(B2:B3)');
  expect(await run('sheets','grid-pivot-read',['info','pivot.xlsx','--json'],{inputs:input('pivot.xlsx')})).toContain('Sheet2');
  expect(await run('sheets','grid-pivot-values',['cat','pivot.xlsx','--sheet','Sheet2','--range','A1:B6'],{inputs:input('pivot.xlsx')})).toContain('70');
 },120000);
 it.skipIf(!existsSync(program('documents')))('Word: tracked replacement and comment persist in OOXML',async()=>{
  await run('documents','word-create',['convert','source.md','source.docx'],{files:[{name:'source.md',text:'# Report\n\nThe budget is 100.\n'}],outputs:output('source.docx')});
  await run('documents','word-review',['run','--file','source.docx','--author','Vunemi QA',...cmd('review.trackChanges',{value:true}),...cmd('edit.replaceAll',{text:'100',with:'200',matchCase:true}),...cmd('select.all',{}),...cmd('review.newComment',{text:'Check revised budget.'}),'--save','reviewed.docx'],{inputs:input('source.docx'),outputs:output('reviewed.docx')});
  expect(xml('reviewed.docx','word/document.xml')).toMatch(/w:ins|w:del/);expect(xml('reviewed.docx','word/comments.xml')).toContain('Check revised budget.');
  expect(await run('documents','word-read',['inspect','reviewed.docx'],{inputs:input('reviewed.docx')})).toContain('200');
 },120000);
 it.skipIf(!existsSync(program('slides')))('Deck: slide layout, notes, autofit and saved readback',async()=>{
  await run('slides','deck-layout-describe',['describe','slide.layout']);
  await run('slides','deck-autofit-catalog',['commands','autofit']);
  await run('slides','deck-create',['run',...cmd('file.new',{blank:true}),...cmd('slide.new',{layout:'titleAndContent',title:'Review',body:'First item\nSecond item'}),...cmd('slide.layout',{index:0,layout:'titleAndContent'}),...cmd('slide.notes',{index:0,text:'Speaker notes persisted.'}),...cmd('insert.textBox',{rect:[60,420,300,40],text:'Autofit QA text'}),...cmd('format.autofit',{mode:'shrink'}),'--save','deck.pptx'],{outputs:output('deck.pptx')});
  expect(xml('deck.pptx','ppt/slides/slide1.xml')).toContain('normAutofit');
  expect(xml('deck.pptx','ppt/notesSlides/notesSlide1.xml')).toContain('Speaker notes persisted.');
  expect(await run('slides','deck-read',['run','--in','deck.pptx',...cmd('slide.inspect',{index:0}),...cmd('document.inspect',{}),'--print'],{inputs:input('deck.pptx')})).toContain('Review');
 },120000);
 it.skipIf(!existsSync(program('photo')))('Photo: directory input batch and directory exports with independent readback',async()=>{
  const photos=join(base,'photos');mkdirSync(photos);
  // Embedded valid 1x1 PNG; all fixture data stays in /tmp.
  writeFileSync(join(photos,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));
  await run('photo','photo-directory-batch',['batch','--actions','actions.json','--in','photos','--out','edited','--format','png'],{inputs:input('photos'),files:[{name:'actions.json',text:JSON.stringify([['image.imageRotation.flipCanvasHorizontal',{}]])}],outputs:output('edited')});
  expect(readdirSync(join(base,'edited'))).toEqual(['pixel.png']);
  const png=readFileSync(join(base,'edited/pixel.png'));expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(png.readUInt32BE(16)).toBe(1);expect(png.readUInt32BE(20)).toBe(1);
  const info=await run('photo','photo-directory-read',['info','edited/pixel.png','--compact'],{inputs:input('edited')});expect(info).toMatch(/width|size/i);
 },120000);
});
