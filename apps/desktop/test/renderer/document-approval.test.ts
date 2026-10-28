import {it,expect} from 'vitest';
import {runAgent,ToolRegistry,taskProgressTool,type AgentEvent,type ChatModel} from '@vunemi/agent-core';
import {foldEvent,pendingApprovals,type RunView} from '../../src/renderer/src/lib/fold.js';
it('shows the application-controlled document approval in the real timeline',async()=>{
 const events:AgentEvent[]=[],tools=new ToolRegistry().register(taskProgressTool());let executed=false,visible=false;
 tools.register({name:'desktop_background_document',description:'open append save',parameters:{type:'object',properties:{path:{type:'string'},text:{type:'string'}}},actionClass:'outbound',alwaysAsk:true,async run(){executed=true;return 'unexpected';}});
 const model:ChatModel={id:'unused',async chat(){throw Error('No model step needed');}};
 await runAgent({goal:'TextEdit arka planda /private/tmp/demo.txt belgesine "new" ekle ve kaydet.',tools,model,planEveryTask:true,requestPlanApproval:async steps=>({kind:'go',steps}),emit:e=>events.push(e),requestApproval:async()=>{
  const pending=pendingApprovals(events.reduce(foldEvent,[] as RunView[]));visible=pending===1;return {kind:'reject'};
 }});
 expect(visible).toBe(true);expect(executed).toBe(false);
});
