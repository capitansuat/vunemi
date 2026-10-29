/** Real pinned Craft engines, opt-in; all files remain local temporary fixtures. */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,realpathSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {Roots} from '@vunemi/files';
import type {ToolContext} from '@vunemi/agent-core';
import {ADDONS,type AddonId} from '../../src/main/addons/catalog.js';
import {createEngines} from '../../src/main/addons/jobs.js';
import {fullAccessTools} from '../../src/main/addons/tools/full-access.js';
import {documentTools} from '../../src/main/addons/tools/documents.js';
const installed = process.env.CRAFT_ADDONS_DIR ?? join(homedir(), 'Library/Application Support/Vunemi/addons');
const program=(id:AddonId)=>{const a=ADDONS.find(a=>a.id===id)!;return join(installed,id,a.tag,a.folder,a.binary);};
const ctx=():ToolContext=>({signal:new AbortController().signal,attach(){},offerUndo(){},handoff:async()=>true});
const cmd=(id:string,args:Record<string,unknown>)=>['--cmd',`${id}=${JSON.stringify(args)}`];
const xml=(path:string,entry:string)=>execFileSync('/usr/bin/unzip',['-p',path,entry],{encoding:'utf8'});
describe.skipIf(process.env.CRAFT_LIVE!=='1'||process.platform!=='darwin')('safe Office edits through actual installed engines',()=>{
 it('backs up Word exactly, repairs one value, retains original styles',async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'safe-word-live-'))),engines=createEngines({home:homedir(),jobsDir:join(base,'jobs'),addons:{binary:id=>program(id),engineDir:id=>join(installed,id,ADDONS.find(a=>a.id===id)!.tag)}}),deps={roots:new Roots([base]),shotDir:base,engines};
  const path=join(base,'report.docx'),tools=documentTools(deps,{paper:()=> 'A4'});await tools.find(t=>t.name==='document_make')!.run({path,markdown:'# Report\n\n**Budget**: 100.\n\n| Metric | Value |\n|---|---|\n| Budget | 100 |\n'},ctx());const before=readFileSync(path),styles=xml(path,'word/styles.xml');expect(xml(path,'word/document.xml')).toContain('w:tblCellMar');expect(xml(path,'word/document.xml')).toContain('w:trHeight');
  const edit=tools.find(t=>t.name==='document_edit')!,args={path,out:path,replaceExisting:true,replace:[{find:'100',with:'200'}]};expect(await edit.preview!(args)).toContain('Backup original');expect(await edit.check!(args)).toBe(null);await edit.run(args,ctx());
  const backup=join(base,readdirSync(base).find(n=>n.includes('before-edit'))!);expect(readFileSync(backup)).toEqual(before);expect(xml(path,'word/document.xml')).toContain('200');expect(xml(path,'word/styles.xml')).toBe(styles);
 },180000);
 for(const id of ['sheets','slides'] as const)it(`${id} edits approved existing export with exact backup and formula/notes readback`,async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),`safe-${id}-live-`))),engines=createEngines({home:homedir(),jobsDir:join(base,'jobs'),addons:{binary:key=>program(key),engineDir:key=>join(installed,key,ADDONS.find(a=>a.id===key)!.tag)}}),tool=fullAccessTools(id,id,id,{roots:new Roots([base]),shotDir:base,engines})[1]!,name=id==='sheets'?'book.xlsx':'deck.pptx',path=join(base,name);
  const initial=id==='sheets'?['run',...cmd('cell.set',{cell:'A1',input:'10'}),...cmd('cell.set',{cell:'A2',input:'20'}),...cmd('cell.set',{cell:'A3',input:'=SUM(A1:A2)'}),'--out',name]:['run',...cmd('file.new',{blank:true}),...cmd('slide.new',{title:'Review',layout:'titleAndContent',body:'Original'}),...cmd('slide.notes',{index:0,text:'Original notes'}),'--save',name];await tool.run({args:initial,outputs:[{name,path}]},ctx());const before=readFileSync(path);
  const changed=id==='sheets'?['run','--in',name,...cmd('cell.set',{cell:'A1',input:'50'}),...cmd('formulas.calculateNow',{}),'--out','updated.xlsx']:['run','--in',name,...cmd('slide.notes',{index:0,text:'Updated notes'}),'--save','updated.pptx'];const args={args:changed,inputs:[{name,path}],outputs:[{name:id==='sheets'?'updated.xlsx':'updated.pptx',path}],replaceExisting:true};expect(await tool.preview!(args)).toContain('Backup original');expect(await tool.check!(args)).toBe(null);await tool.run(args,ctx());expect(readFileSync(join(base,readdirSync(base).find(n=>n.includes('before-edit'))!))).toEqual(before);if(id==='sheets'){expect(xml(path,'xl/worksheets/sheet1.xml')).toContain('SUM(A1:A2)');expect(await tool.run({args:['cat',name,'--range','A1:A3'],inputs:[{name,path}]},ctx())).toContain('70');}else expect(xml(path,'ppt/notesSlides/notesSlide1.xml')).toContain('Updated notes');
 },180000);
});
