import {it,expect} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import {taskProgressTool} from '../src/tasks.js';
import {prepareChoice} from '../src/choices.js';
import type {AgentEvent} from '../src/events.js';
it.each([true,false])('replaces singular Turkish prose permission with a real action card (progress=%s)',async tracking=>{
 const events:AgentEvent[]=[];let turn=0,actions=0,cards=0;
 const tools=new ToolRegistry();if(tracking)tools.register(taskProgressTool());
 tools.register({name:'save_note',description:'save note',parameters:{type:'object',properties:{}},actionClass:'write-local',run:async()=>{actions++;return 'Saved';}});
 const model={id:'fixture',chat:async(_r:unknown,onChunk:(c:{kind:'text';text:string})=>void)=>{
  const text=turn===0?'Notu kaydetmemi onaylıyor musun?':'Kaydedildi.';
  const calls=turn++===0?[]:[{id:'save',name:'save_note',argumentsText:'{}'}];
  if(turn>2)return {text:'Kaydedildi.',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};
  for(const piece of [text.slice(0,12),text.slice(12)])onChunk({kind:'text',text:piece});
  return {text: calls.length?'':text,toolCalls:calls,usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};
 }};
 await runAgent({goal:'Save my note',tools,model,emit:e=>events.push(e),requestApproval:async()=>{cards++;return {kind:'reject'};}});
 expect(cards).toBe(1);expect(actions).toBe(0);
 expect(events.filter(e=>e.type==='message.delta').map(e=>e.text).join('')).not.toContain('onaylıyor musun');
 expect(events.some(e=>e.type==='approval.resolved'&&e.decision.kind==='reject')).toBe(true);
});
it.each(['Onaylıyor musun?','İzin verir misin?','Terminal açmamı onaylıyor musun?','May I open Terminal?'])('rejects prose permission disguised as a choice: %s',question=>{
 const result=prepareChoice('ask_choice',{question,options:['Evet','Hayır']},{local:[],pages:[]});
 expect(result).toHaveProperty('error',expect.stringContaining('Do not ask action permission'));
});

it('does not invent an approval wait after a non-retryable policy block',async()=>{
 let turns=0,cards=0;const events:AgentEvent[]=[];
 const tools=new ToolRegistry().register(taskProgressTool()).register({name:'desktop_windows',description:'read windows',parameters:{type:'object',properties:{}},actionClass:'read',run:async()=>{throw Object.assign(Error('System Settings is blocked by policy; no approval can override it.'),{retryable:false});}});
 const model={id:'fixture',chat:async()=>{const first=turns++===0;return {text:first?'':'Terminal açmamı onaylıyor musun?',toolCalls:first?[{id:'blocked',name:'desktop_windows',argumentsText:'{}'}]:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 const result=await runAgent({goal:'Read System Settings',tools,model,emit:e=>events.push(e),requestApproval:async()=>{cards++;return {kind:'approve'};}});
 expect(result.status).toBe('failed');expect(turns).toBe(2);expect(cards).toBe(0);
 expect(events.find(e=>e.type==='tool.finished'&&!e.ok)).not.toHaveProperty('retryable',true);
});
it.each(['Notu yazmama onaylar mısın?','Yapayım mı?','Would you like me to write the note?','Should I check updates?','Genehmigen Sie das Öffnen?','Autorisez-vous cette action ?','¿Autorizas esta acción?','Autorizzi questa azione?','Você autoriza esta ação?','Вы разрешаете это действие?','是否允许我执行？','承認していただけますか？','승인하시겠습니까?'])('recognizes action permission phrasing: %s',question=>{
 expect(prepareChoice('ask_choice',{question,options:['Yes','No']},{pages:[],local:[]})).toHaveProperty('error',expect.stringContaining('Do not ask action permission'));
});
