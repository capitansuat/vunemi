import {it,expect} from 'vitest';
import {verifyText} from '../src/verification.js';
it('checks actual contents, CSV shape, row count and forbidden unsupported claims',()=>{
 expect(verifyText('a,b\n1,33,33',{rows:1})).toMatch(/fields/);
 expect(verifyText('a,b\n1,33.33',{rows:1,contains:['33.33']})).toBeNull();
 expect(verifyText('Margin target exceeded',{excludes:['target exceeded']})).toMatch(/Forbidden/);
 expect(verifyText('profit 40000',{contains:['38000']})).toMatch(/Missing/);
});
it('compares visible Markdown text without confusing bold punctuation with a missing value',()=>{
 expect(verifyText('- **Toplam Gelir:** 106.500 TL',{contains:['Toplam Gelir: 106.500 TL']})).toBeNull();
});

it('uses file format for structural checks rather than parsing Markdown as CSV',()=>{
 expect(verifyText('# Report\n\nprofit 260\n',{rows:2},'report.md')).toMatch(/CSV.*only/i);
 expect(verifyText('# Report\n\nprofit 260\n',{lines:3,contains:['260']},'report.md')).toBeNull();
 expect(verifyText('profit 260\n',{lines:3},'summary.txt')).toMatch(/lines/);
 expect(verifyText('a,b\n1,2,3',{contains:['1']},'report.csv')).toMatch(/fields/);
 expect(verifyText('{"profit":260,}',{contains:['260']},'report.json')).toMatch(/JSON/);
 expect(verifyText('{"profit":260}',{contains:['260']},'report.json')).toBeNull();
 expect(verifyText('profit 260',{columns:3} as never,'summary.txt')).toMatch(/Unknown/);
});
it('supports a real nonempty check for controller reads without pretending it proves source values',()=>{
 expect(verifyText('   \n',{nonempty:true},'summary.txt')).toMatch(/empty/i);
 expect(verifyText('profit 260',{nonempty:true},'summary.txt')).toBeNull();
 expect(verifyText('a,b\n1,2,3',{nonempty:true},'data.csv')).toMatch(/fields/);
});
