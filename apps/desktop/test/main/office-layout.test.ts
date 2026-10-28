import {expect,it} from 'vitest';
import {sheetScript} from '../../src/main/addons/tools/sheets.js';
import {deckArgs,slideTools} from '../../src/main/addons/tools/slides.js';
it('keeps formulas/data untouched while aligning numeric cells and matching fractional precision',()=>{
 const steps=sheetScript([['Kalem','Değer'],['Alfa',12.5],['Beta',7.25],['Gama',20.25],['Toplam','=SUM(B2:B4)']]).trim().split('\n').map(s=>JSON.parse(s));
 expect(steps).toContainEqual({id:'cell.set',params:{cell:'B5',input:'=SUM(B2:B4)'}});
 expect(steps).toContainEqual({id:'home.numberFormat',params:{range:'B2:B5',code:'0.00'}});
 expect(steps).toContainEqual({id:'home.alignRight',params:{range:'B2:B5'}});
 expect(steps).toContainEqual({id:'home.rowHeight',params:{rows:'1:5',height:32}});
 expect(steps).toContainEqual({id:'home.bold',params:{range:'A5:B5',on:true}});
 expect(JSON.stringify(steps)).not.toMatch(/Currency|Accounting|symbol/);
});
it('does not format mixed text columns or silently round high precision source values',()=>{
 const steps=sheetScript([['Label','Value'],['A',1.23456],['B',2],['Total','=SUM(B2:B3)']]);
 expect(steps).toContain('0.00000');expect(steps).not.toContain('"range":"A2:A4"');
});
it('enables shrink autofit on newly generated slides without changing theme font hierarchy',()=>{
 const args=deckArgs([{layout:'titleAndContent',title:'Review',body:['Revenue 40'],notes:''}],undefined);
 expect(args).toContain('edit.selectAll={}');expect(args).toContain('format.autofit={"mode":"shrink"}');expect(args.join(' ')).not.toContain('format.size');
});
it('rejects overfull new slides instead of clipping or silently dropping supplied body lines',()=>{
 const tool=slideTools({roots:{resolve:(p:string)=>p} as never} as never)[0]!;
 expect(tool.check!({path:'/tmp/deck.pptx',slides:[{title:'Review',body:Array.from({length:7},(_,i)=>`Line ${i}`)}]})).toMatch(/six|6/i);
});
it('new Word table layout addresses inspected table positions and uses minimum height without rewriting values',async()=>{
 const {newWordTableLayout}=await import('../../src/main/addons/tools/office-word-layout.js');
 const args=newWordTableLayout(JSON.stringify({blocks:[{index:0,type:'paragraph',text:'Report'},{index:1,type:'table',cells:[['Kalem','Değer'],['Alfa','12.50'],['Toplam','12.50']]}]}));
 expect(args).toContain('caret.set={"pos":{"path":[1,0,0,0],"off":0,"story":"body"}}');expect(args).toContain('table.cellMargins={"top":4,"bottom":4,"left":6,"right":6}');expect(args.join(' ')).not.toContain('edit.replace');
});
it('slide replacement is opt-in and preview names its original backup',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {Roots}=await import('@vunemi/files');const dir=mkdtempSync(join(tmpdir(),'slide-replace-'));
 try{const path=join(dir,'existing.pptx');writeFileSync(path,'original');const tool=slideTools({roots:new Roots([dir])} as never).find(t=>t.name==='slides_edit')!;const args={path,out:path,replace:[{find:'Old',with:'New'}]};expect(await tool.check!(args)).toBeTruthy();const replacement={...args,replaceExisting:true};expect(await tool.check!(replacement)).toBeNull();expect(await tool.preview!(replacement)).toMatch(/before-edit/);expect(tool.alwaysAskWhen!(replacement)).toBe(true)}finally{rmSync(dir,{recursive:true,force:true})}
});
it('right-aligns only clean numeric Word data cells and keeps source text/units',async()=>{
 const {newWordTableLayout}=await import('../../src/main/addons/tools/office-word-layout.js');const args=newWordTableLayout(JSON.stringify({blocks:[{index:2,type:'table',cells:[['Item','Value'],['Alfa','12.50'],['Units','40 kg']]}]}));
 expect(args).toContain('caret.set={"pos":{"path":[2,1,1,0],"off":0,"story":"body"}}');expect(args.filter(a=>a==='para.alignRight={}')).toHaveLength(1);expect(args).not.toContain('caret.set={"pos":{"path":[2,2,1,0],"off":0,"story":"body"}}');
});
it('bounds generated Word layout arguments before export instead of risking E2BIG',async()=>{
 const {newWordTableLayout}=await import('../../src/main/addons/tools/office-word-layout.js');
 expect(()=>newWordTableLayout(JSON.stringify({blocks:[{index:1,type:'table',cells:Array.from({length:1000},()=>['12.50','40.00'])}]}))).toThrow(/budget|too large|limit/i);
});
