import {expect,it,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readOffice} from '../src/office-read.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})});
async function fixture(parts:Record<string,string>,ext='xlsx') {const dir=mkdtempSync(join(tmpdir(),'office-read-'));dirs.push(dir);for(const [name,text]of Object.entries(parts)){const path=join(dir,name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text)}const path=join(dir,`fixture.${ext}`);execFileSync('/usr/bin/zip',['-q',path,...Object.keys(parts)],{cwd:dir});return path}
const workbook={'xl/workbook.xml':'<workbook><sheets><sheet name="Budget" r:id="r1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet2.xml" Type="x/worksheet"/></Relationships>','xl/worksheets/sheet2.xml':'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Amount</t></is></c><c r="B2"><f>SUM(B1)</f><v>40</v></c></row></sheetData></worksheet>'};
it('reads actual cells/formulas/caches in workbook order',async()=>{expect(await readOffice(await fixture(workbook),'.xlsx')).toContain('B2: formula=SUM(B1); cached=40')});
it('rejects spreadsheet error values',async()=>{await expect(readOffice(await fixture({...workbook,'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row><c r="A1" t="e"><v>#REF!</v></c></row></sheetData></worksheet>'}),'.xlsx')).rejects.toThrow(/error cell/i)});
it('rejects broken relationships and malformed XML',async()=>{await expect(readOffice(await fixture({...workbook,'xl/workbook.xml':'<workbook><sheets><sheet r:id="missing" name="Bad"/></sheets></workbook>'}),'.xlsx')).rejects.toThrow();await expect(readOffice(await fixture({...workbook,'xl/workbook.xml':'<workbook><sheets></workbook>'}),'.xlsx')).rejects.toThrow()});
it('preserves ordered slide relationships and notes',async()=>{
 const ppt={'ppt/presentation.xml':'<p:presentation><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>','ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>','ppt/slides/slide1.xml':'<p:sld><a:p><a:r><a:t>First physical</a:t></a:r></a:p></p:sld>','ppt/slides/slide2.xml':'<p:sld><a:p><a:r><a:t>Ordered first</a:t></a:r></a:p></p:sld>','ppt/slides/_rels/slide2.xml.rels':'<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide2.xml"/></Relationships>','ppt/notesSlides/notesSlide2.xml':'<p:notes><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>'};
 expect(await readOffice(await fixture(ppt,'pptx'),'.pptx')).toBe('Slide 1\nOrdered first\nNotes:\nSpeaker note\nSlide 2\nFirst physical');
 await expect(readOffice(await fixture({...ppt,'ppt/presentation.xml':'<presentation><sldId r:id="missing"/></presentation>'},'pptx'),'.pptx')).rejects.toThrow();
});
it('reads shared rich text and inline entities, refuses unresolved references',async()=>{
 const sheet='<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>A &amp; B</t></is></c></row></sheetData></worksheet>';
 const parts={...workbook,'xl/sharedStrings.xml':'<sst><si><r><t>Hello </t></r><r><t>world</t></r></si></sst>','xl/worksheets/sheet2.xml':sheet};
 expect(await readOffice(await fixture(parts),'.xlsx')).toBe('Sheet: Budget\nA1: Hello world\nB1: A & B');
 await expect(readOffice(await fixture({...parts,'xl/sharedStrings.xml':'<sst/>'}),'.xlsx')).rejects.toThrow(/shared string/);
});
it('refuses incomplete formula caches and DTD/XML declarations',async()=>{
 await expect(readOffice(await fixture({...workbook,'xl/worksheets/sheet2.xml':'<worksheet><c r="A1"><f>1+1</f></c></worksheet>'}),'.xlsx')).rejects.toThrow(/formula cache/);
 await expect(readOffice(await fixture({...workbook,'xl/workbook.xml':'<!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook/>'}),'.xlsx')).rejects.toThrow(/declaration/);
});
it('refuses excessive decompressed data and truncated/corrupt archives',async()=>{
 await expect(readOffice(await fixture({...workbook,'xl/worksheets/sheet2.xml':'<worksheet>'+ 'x'.repeat(2_100_000)+'</worksheet>'}),'.xlsx')).rejects.toThrow();
 const dir=mkdtempSync(join(tmpdir(),'office-corrupt-'));dirs.push(dir);const path=join(dir,'bad.xlsx');writeFileSync(path,'PK corrupt');await expect(readOffice(path,'.xlsx')).rejects.toThrow();
});
it('refuses text that would be truncated rather than passing content checks',async()=>{
 await expect(readOffice(await fixture({...workbook,'xl/worksheets/sheet2.xml':'<worksheet><c r="A1" t="inlineStr"><is><t>'+ 'x'.repeat(125_000)+'</t></is></c></worksheet>'}),'.xlsx')).rejects.toThrow(/complete read limit/);
});
it('files_read retains Roots permissions and verifies source-grounded content checks',async()=>{
 const {createFileTools,Roots}=await import('../src/index.js');
 const {dirname}=await import('node:path');const path=await fixture(workbook);
 const reader=createFileTools({roots:new Roots([dirname(path)]),shadowDir:join(dirname(path),'shadow')}).find(tool=>tool.name==='files_read')!;
 const ctx:import('@vunemi/agent-core').ToolContext={signal:new AbortController().signal,handoff:async()=>true,offerUndo:()=>{},attach:()=>{},produced:()=>{}};
 const output=await reader.run({path,checks:{contains:['Budget','formula=SUM(B1); cached=40'],nonempty:true}},ctx);
 expect(output).toContain('Amount');
 await expect(reader.run({path,checks:{contains:['Fabricated value']}},ctx)).rejects.toThrow(/Missing required content/);
 const noAccess=createFileTools({roots:new Roots([]),shadowDir:join(dirname(path),'shadow')}).find(tool=>tool.name==='files_read')!;
 await expect(noAccess.run({path},ctx)).rejects.toThrow();
});
it('refuses duplicate worksheet relationships and missing targets',async()=>{
 await expect(readOffice(await fixture({...workbook,'xl/workbook.xml':'<workbook><sheets><sheet name="One" r:id="r1"/><sheet name="Two" r:id="r1"/></sheets></workbook>'}),'.xlsx')).rejects.toThrow(/relationship/);
 await expect(readOffice(await fixture({...workbook,'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="../../outside.xml"/></Relationships>'}),'.xlsx')).rejects.toThrow(/relationship/);
});
it('reads actual pinned Craft workbook and presentation fixture shapes',async()=>{
 const base=new URL('./fixtures/office-craft/',import.meta.url);
 const {fileURLToPath}=await import('node:url');
 const grid=await readOffice(fileURLToPath(new URL('grid-edited.xlsx',base)),'.xlsx');
 expect(grid).toContain('cached=70');
 const source=await readOffice(fileURLToPath(new URL('grid-source.xlsx',base)),'.xlsx');
 expect(source).toContain('cached=30');
 const deck=await readOffice(fileURLToPath(new URL('deck-source.pptx',base)),'.pptx');
 expect(deck).toContain('Slide 1');expect(deck).toContain('Notes:');
 await expect(readOffice(fileURLToPath(new URL('grid-errors.xlsx',base)),'.xlsx')).rejects.toThrow(/error cell/);
});
it('preserves workbook sheet order independently of ZIP file names',async()=>{
 const parts={...workbook,'xl/workbook.xml':'<workbook><sheets><sheet name="Second file" r:id="r1"/><sheet name="First file" r:id="r2"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet2.xml"/><Relationship Id="r2" Target="worksheets/sheet1.xml"/></Relationships>','xl/worksheets/sheet1.xml':'<worksheet><c r="A1" t="inlineStr"><is><t>Last sheet marker</t></is></c></worksheet>'};
 const output=await readOffice(await fixture(parts),'.xlsx');expect(output.indexOf('Sheet: Second file')).toBeLessThan(output.indexOf('Sheet: First file'));expect(output).toContain('Last sheet marker');
});
it('refuses excessive archive entries and unknown XML attribute entities',async()=>{
 const parts={...workbook};for(let i=0;i<1501;i++)Object.assign(parts,{[`extra${i}.xml`]:'<extra/>'});
 await expect(readOffice(await fixture(parts),'.xlsx')).rejects.toThrow(/archive entries/);
 await expect(readOffice(await fixture({...workbook,'xl/workbook.xml':'<workbook><sheet name="&unresolved;" r:id="r1"/></workbook>'}),'.xlsx')).rejects.toThrow(/entity/);
});
