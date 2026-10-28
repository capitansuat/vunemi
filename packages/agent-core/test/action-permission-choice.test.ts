import { expect, it } from 'vitest';
import { prepareChoice } from '../src/choices.js';
const evidence={pages:[],local:[]};
it.each(['Aşağıdaki metni rapor.md dosyasına yazayım mı?\n\n---\nİçerik','Özeti kaydetmemi onaylıyor musunuz?','Shall I write this report?','May I send this email?','Do you approve deleting this file?'])('refuses an action permission question before creating a choice card: %s',question=>{
 expect(prepareChoice('ask_choice',{question,options:['Yes','No']},evidence)).toHaveProperty('error');
});
it.each(['Rapor kısa mı ayrıntılı mı olsun?','Hangi klasöre yazayım?','Should I write the report in Turkish or English?','Which recipient should receive the email?','Does this draft need a different tone?'])('preserves a real preference or missing parameter question: %s',question=>{
 expect(prepareChoice('ask_choice',{question,options:['A','B']},evidence)).toHaveProperty('card');
});

it('redirects rejected permission choices to the real approval without writing early',async()=>{
 const {runAgent}=await import('../src/agent.js');
 const {ToolRegistry}=await import('../src/tools.js');
 const {choiceTools}=await import('../src/choices.js');
 let turns=0,writes=0,approvals=0,questions=0;
 const tools=new ToolRegistry();for(const t of choiceTools())tools.register(t);
 tools.register({name:'files_write',description:'write',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async()=>{writes++;return 'saved';}});
 const calls=[{id:'q',name:'ask_choice',argumentsText:JSON.stringify({question:'Dosyaya yazayım mı?',options:['Evet','Hayır']})},{id:'w',name:'files_write',argumentsText:'{}'}];
 const result=await runAgent({emit:()=>{},goal:'Write report',tools,model:{id:'local:test',chat:async()=>{const call=calls[turns++];return {text:call?'':'Saved.',toolCalls:call?[call]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}},requestChoice:async()=>{questions++;return {index:0,text:''};},requestApproval:async()=>{expect(writes).toBe(0);approvals++;return {kind:'approve'};}});
 expect(result.status).toBe('done');expect(questions).toBe(0);expect(approvals).toBe(1);expect(writes).toBe(1);
});
it('does not turn requested output files into selectable alternatives',async()=>{
 const {runAgent}=await import('../src/agent.js');const {ToolRegistry}=await import('../src/tools.js');const {choiceTools}=await import('../src/choices.js');
 let turns=0,questions=0;const tools=new ToolRegistry();for(const t of choiceTools())tools.register(t);
 await runAgent({requestApproval:async()=>({kind:'approve'}),emit:()=>{},tools,goal:'Create report.md and summary.txt',model:{id:'test',chat:async()=>({text:turns++?'Done':'',toolCalls:turns===1?[{id:'q',name:'present_options',argumentsText:JSON.stringify({items:[{title:'report.md',view:'report'},{title:'summary.txt',view:'summary'}]})}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})},requestChoice:async()=>{questions++;return {index:0,text:''};}});
 expect(questions).toBe(0);
});
it('does not request a converter preview as a substitute for file verification',async()=>{
 const {runAgent}=await import('../src/agent.js');const {ToolRegistry}=await import('../src/tools.js');let turns=0,approvals=0,runs=0;
 const tools=new ToolRegistry().register({name:'system_run',description:'converter',actionClass:'write-local',parameters:{type:'object',properties:{}},run:async()=>{runs++;return 'preview';}});
 await runAgent({emit:()=>{},tools,goal:'Create report.md and verify contents',model:{id:'test',chat:async()=>({text:turns++?'Cannot preview':'',toolCalls:turns===1?[{id:'p',name:'system_run',argumentsText:'{"command":"qlmanage","args":["-p","/tmp"]}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})},requestApproval:async()=>{approvals++;return {kind:'approve'};}});
 expect(runs).toBe(0);expect(approvals).toBe(0);
});
