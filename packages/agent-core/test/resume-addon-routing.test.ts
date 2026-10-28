import {expect,it,vi} from 'vitest';
import {runAgent} from '../src/agent.js';
import {ToolRegistry} from '../src/tools.js';
import {tasksFromEvents} from '../src/tasks.js';
import type {ChatRequest} from '../src/provider.js';

it.each([false,true])('restores all explicitly requested add-on areas before the resumed model turn (cached=%s)',async cached=>{
 const executed=vi.fn(async()=> 'created');
 const tools=new ToolRegistry();
 for(const [name,area,wanted] of [['document_make','documents',/docx/],['sheet_make','sheets',/xlsx/],['slides_make','slides',/pptx/]] as const)
  tools.register({name,description:name,parameters:{type:'object',properties:{}},actionClass:'write-local',onDemand:area,wantedFor:wanted,run:executed},'addon:'+area);
 const task=tasksFromEvents([{type:'run.started',runId:'original',model:'fixture',goal:'Create /tmp/report.docx, /tmp/data.xlsx and /tmp/slides.pptx',at:1},{type:'tool.proposed',runId:'original',stepId:'s',callId:'doc',tool:'document_make',args:{},actionClass:'write-local'},{type:'tool.started',runId:'original',callId:'doc',at:2},{type:'tool.finished',runId:'original',callId:'doc',ok:true,output:'created',durationMs:1},{type:'run.finished',runId:'original',status:'stopped',detail:'Stopped by user',at:3}])[0]!;
 const seen:ChatRequest[]=[];
 const ask=vi.fn(async()=>({kind:'reject' as const}));
 await runAgent({goal:'Devam et',resumeTask:task,tools,areas:[{id:'documents',summary:'documents'},{id:'sheets',summary:'sheets'},{id:'slides',summary:'slides'}],shownTools:new Set(cached?['document_make','tool_run']:[]),pickAreas:async()=>['documents'],maxSteps:1,emit:()=>{},requestApproval:ask,model:{id:'fixture',chat:async req=>{seen.push(req);return {text:'',toolCalls:[{id:'sheet',name:'sheet_make',argumentsText:'{}'}],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}}});
 expect(seen[0]!.tools.map(t=>t.name)).toEqual(expect.arrayContaining(['document_make','sheet_make','slides_make']));
 expect(ask).toHaveBeenCalledTimes(1);
 expect(executed).not.toHaveBeenCalled();
});
