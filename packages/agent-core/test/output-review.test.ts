import {it,expect} from 'vitest';
import {reviewOutput} from '../src/output-review.js';
import type {ChatModel} from '../src/provider.js';
const model=(text:string):ChatModel=>({id:'local',chat:async r=>{expect(r.tools).toEqual([]);expect(r.messages[0]!.content).toContain('source');return {text,toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}});
it('requires a separate successful source review, and feeds actual defects back',async()=>{
 expect(await reviewOutput(model('{"ok":false,"issues":["12000 to 24000 increases by 12000, not 10000","No margin target was supplied"]}'),'Report','CSV and target','Wrong report',new AbortController().signal)).toEqual(['12000 to 24000 increases by 12000, not 10000','No margin target was supplied']);
 expect(await reviewOutput(model('{"ok":true,"issues":[]}'),'Report','CSV','Correct report',new AbortController().signal)).toEqual([]);
 expect(await reviewOutput(model('looks good'),'Report','CSV','report',new AbortController().signal)).not.toEqual([]);
});
it('reviews only the named artifact requirements, never the separately delivered files',async()=>{
 const scoped:ChatModel={id:'local',chat:async r=>{const data=JSON.parse(r.messages[1]!.content);expect(data.request).toContain('Ay,Gelir');expect(data.request).not.toContain('rapor.md');expect(data.output_file).toBe('analiz.csv');return {text:'{"ok":true,"issues":[]}',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 expect(await reviewOutput(scoped,'Read sources. 1) analiz.csv: Ay,Gelir, six rows. 2) rapor.md: totals. 3) ozet.txt: three sentences.','CSV','actual CSV',new AbortController().signal,undefined,'analiz.csv')).toEqual([]);
});
it('scopes unnumbered Office destinations while keeping shared currency constraints',async()=>{const scoped:ChatModel={id:'local',chat:async r=>{const data=JSON.parse(r.messages[1]!.content);expect(data.request).toContain('rapor.docx');expect(data.request).toContain('tek bir tablo');expect(data.request).toContain('Para birimi ekleme');expect(data.request).not.toContain('hesap.xlsx');expect(data.request).not.toContain('sunum.pptx');expect(data.additional_user_requirements).toContain('rapor.docx');expect(data.additional_user_requirements).not.toContain('sunum.pptx');return {text:'{"ok":true,"issues":[]}',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};await reviewOutput(scoped,'/tmp/rapor.docx dosyasına tek bir tablo yaz. /tmp/hesap.xlsx dosyasına SUM formülü yaz. /tmp/sunum.pptx dosyasına iki slayt yaz. Para birimi ekleme.','','actual',new AbortController().signal,undefined,'rapor.docx','rapor.docx başlığı Rapor olsun. sunum.pptx başlığı Sunum olsun.');});
