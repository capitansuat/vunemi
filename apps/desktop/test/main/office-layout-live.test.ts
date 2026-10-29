import {expect,it} from 'vitest';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Roots,createFileTools} from '@vunemi/files';
import type {ToolContext} from '@vunemi/agent-core';
import {ADDONS,type AddonId} from '../../src/main/addons/catalog.js';
import {createEngines} from '../../src/main/addons/jobs.js';
import {newWordTableLayout} from '../../src/main/addons/tools/office-word-layout.js';
import {sheetTools} from '../../src/main/addons/tools/sheets.js';
import {slideTools} from '../../src/main/addons/tools/slides.js';
it.skipIf(process.env.CRAFT_LIVE!=='1'||process.platform!=='darwin')('real generated Office layout preserves values and stores actual layout properties',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'vunemi-layout-'))),evidence=resolve('../../research/office-design-2026-10-15',new Date().toISOString().replaceAll(':','-'));mkdirSync(evidence,{recursive:true});
 const installed = process.env.CRAFT_ADDONS_DIR ?? join(homedir(), 'Library/Application Support/Vunemi/addons');const program=(id:AddonId)=>{const a=ADDONS.find(a=>a.id===id)!;return join(installed,id,a.tag,a.folder,a.binary)};
 const engines=createEngines({home:homedir(),jobsDir:join(base,'jobs'),addons:{binary:program,engineDir:id=>join(installed,id,ADDONS.find(a=>a.id===id)!.tag)}});
 const ctx:ToolContext={signal:new AbortController().signal,handoff:async()=>true,offerUndo:()=>{},attach:()=>{},gallery:()=>{}};const deps={engines,roots:new Roots([base]),shotDir:base};
 const xml=(name:string,part:string)=>execFileSync('/usr/bin/unzip',['-p',join(base,name),part],{encoding:'utf8'});
 try{
  const sheet=join(base,'layout.xlsx');await sheetTools(deps)[0]!.run({path:sheet,rows:[['Kalem','Değer'],['Alfa',12.5],['Beta',7.25],['Gama',20.25],['Toplam','=SUM(B2:B4)']]},ctx);
  copyFileSync(sheet,join(evidence,'layout.xlsx'));const styles=xml('layout.xlsx','xl/styles.xml'),cells=xml('layout.xlsx','xl/worksheets/sheet1.xml');writeFileSync(join(evidence,'styles.xml'),styles);writeFileSync(join(evidence,'sheet.xml'),cells);
  expect(styles).toContain('horizontal="right"');expect(styles).toMatch(/0\.00|numFmtId="2"/);expect(cells).toContain('ht="24"');expect(cells).toContain('SUM(B2:B4)');expect(cells).toMatch(/<v>40<\/v>/);
  await engines('sheets',ctx.signal,async job=>{copyFileSync(sheet,join(job.dir,'in.xlsx'));const result=await job.run(['convert','in.xlsx','layout.html']);expect(result.code).toBe(0);copyFileSync(join(job.dir,'layout.html'),join(evidence,'layout.html'))});
  const deck=join(base,'layout.pptx');await slideTools(deps)[0]!.run({path:deck,theme:'Harbor',slides:[{title:'Office Kabul Denemesi',body:['Veri özeti ve kontrol edilmiş toplam']},{title:'Sayısal sonuçlar',body:['Alfa: 12.50','Beta: 7.25','Gama: 20.25','Toplam: 40'],notes:'Kaynak değerler korunmuştur.'}]},ctx);
  copyFileSync(deck,join(evidence,'layout.pptx'));const slide=xml('layout.pptx','ppt/slides/slide2.xml');writeFileSync(join(evidence,'slide2.xml'),slide);expect(slide).toContain('normAutofit');
  await engines('slides',ctx.signal,async job=>{copyFileSync(deck,join(job.dir,'in.pptx'));const result=await job.run(['render','in.pptx','--all','--scale','1','rendered']);writeFileSync(join(evidence,'render-result.json'),JSON.stringify(result));expect(result.code).toBe(0);const files=readdirSync(join(job.dir,'rendered')).filter(f=>f.endsWith('.png')).sort();expect(files).toHaveLength(2);files.forEach((f,i)=>copyFileSync(join(job.dir,'rendered',f),join(evidence,`slide${i+1}.png`)))});
  const reader=createFileTools({roots:deps.roots,shadowDir:join(base,'shadows')}).find(t=>t.name==='files_read')!;
  const sheetRead=String(await reader.run({path:sheet,checks:{contains:['Alfa','formula=SUM(B2:B4); cached=40']}},ctx));const deckRead=String(await reader.run({path:deck,checks:{contains:['Toplam: 40','Kaynak değerler korunmuştur.']}},ctx));writeFileSync(join(evidence,'independent-read.txt'),sheetRead+'\n\n'+deckRead);
  const originalDeckHash=createHash('sha256').update(readFileSync(deck)).digest('hex');
  const editTool=slideTools(deps).find(tool=>tool.name==='slides_edit')!;
  const editArgs={path:deck,out:deck,replaceExisting:true,replace:[{find:'Sayısal sonuçlar',with:'Kontrol edilmiş sonuçlar'}]};
  expect(await editTool.check!(editArgs)).toBeNull();expect(await editTool.preview!(editArgs)).toContain('before-edit');
  await editTool.run(editArgs,ctx);
  const backup=readdirSync(base).find(name=>name.startsWith('layout.before-edit-')&&name.endsWith('.pptx'))!;expect(backup).toBeTruthy();expect(createHash('sha256').update(readFileSync(join(base,backup))).digest('hex')).toBe(originalDeckHash);
  copyFileSync(join(base,backup),join(evidence,'layout-before-edit.pptx'));copyFileSync(deck,join(evidence,'layout-edited.pptx'));
  expect(String(await reader.run({path:deck,checks:{contains:['Kontrol edilmiş sonuçlar','Toplam: 40']}},ctx))).not.toContain('Sayısal sonuçlar');
  await engines('documents',ctx.signal,async job=>{
   writeFileSync(join(job.dir,'table.md'),'# Report\n\n| Item | Value |\n|---|---|\n| Alfa | 12.50 |\n| Beta | 7.25 |\n| Gama | 20.25 |\n| **Total** | **40.00** |\n\n## Second table\n\n| Detail | Explanation |\n|---|---|\n| Note | A longer explanatory cell must be allowed to wrap naturally without a fixed row height cutting its contents. |\n');
   expect((await job.run(['convert','table.md','plain.docx'])).code).toBe(0);
   const inspection=await job.run(['inspect','plain.docx']);expect(inspection.code).toBe(0);
   const args=newWordTableLayout(inspection.stdout);const result=await job.run(['run','--file','plain.docx',...args,'--save','spaced.docx']);writeFileSync(join(evidence,'word-layout-result.json'),JSON.stringify({args,result}));expect(result.code).toBe(0);
   copyFileSync(join(job.dir,'spaced.docx'),join(evidence,'spaced.docx'));
   const raw=execFileSync('/usr/bin/unzip',['-p',join(job.dir,'spaced.docx'),'word/document.xml'],{encoding:'utf8'});writeFileSync(join(evidence,'word-layout.xml'),raw);expect(raw.match(/<w:tblCellMar>/g)).toHaveLength(2);expect(raw).toContain('<w:top w:w="80"');expect(raw.match(/<w:trHeight /g)).toHaveLength(7);expect(raw).toContain('w:hRule="atLeast"');expect(raw.match(/<w:jc w:val="right"/g)).toHaveLength(4);expect(raw).toContain('12.50');expect(raw).toContain('40.00');
   expect((await job.run(['render','spaced.docx','word.png','--page','1','--scale','1'])).code).toBe(0);copyFileSync(join(job.dir,'word.png'),join(evidence,'word.png'));
  });
  writeFileSync(join(evidence,'summary.json'),JSON.stringify({status:'pass',engines:['sheets','slides'].map(id=>({id,sha256:createHash('sha256').update(readFileSync(program(id as AddonId))).digest('hex')})),sheet:'right alignment;0.00;24pt rows;formula/cache40',slides:'actual normAutofit;2slides;notes retained'},null,2));
 }finally{rmSync(base,{recursive:true,force:true})}
},120000);
