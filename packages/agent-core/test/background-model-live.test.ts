/** Real installed model + synthetic handlers ONLY. No native/UI/Helper calls. */
import {it,expect,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {runAgent} from '../src/agent.js';
import {createModel,type ChatModel} from '../src/provider.js';
import {ToolRegistry} from '../src/tools.js';
import {taskProgressTool,tasksFromEvents} from '../src/tasks.js';
import type {AgentEvent} from '../src/events.js';
import {Helper} from '../../mac/src/helper.js';
import {createDesktopTools} from '../../mac/src/tools.js';

it.skipIf(process.env.VUNEMI_BACKGROUND_MODEL_LIVE!=='1')('real installed model performs one synthetic Calculator7 press after required read in area mode',async()=>{
 // Never print raw process arguments, endpoint credentials, provider config or headers.
 let config:{baseUrl:string;apiKey:string;model:string};
 try{config=JSON.parse(execFileSync('python3',['-c',`import subprocess,shlex,json,urllib.request,os
p=subprocess.run(['pgrep','-f','^/Applications/Vunemi.app/Contents/Resources/llama-server( |$)'],capture_output=True,text=True)
pids=p.stdout.split();selected=os.environ.get('VUNEMI_BACKGROUND_MODEL_PID')
assert (selected in pids if selected else len(pids)==1)
args=shlex.split(subprocess.run(['ps','-p',selected or pids[0],'-o','args='],capture_output=True,text=True).stdout)
def flag(name):
 if name in args:return args[args.index(name)+1]
 return next(x.split('=',1)[1] for x in args if x.startswith(name+'='))
base='http://127.0.0.1:'+flag('--port');key=flag('--api-key')
models=json.load(urllib.request.urlopen(urllib.request.Request(base+'/v1/models',headers={'Authorization':'Bearer '+key}),timeout=10))
print(json.dumps({'baseUrl':base+'/v1','apiKey':key,'model':models['data'][0]['id']}))`],{stdio:['ignore','pipe','pipe'],timeout:15000}).toString());}catch{throw Error('Installed model credentials unavailable; diagnostic stopped without effects.');}
 const root=resolve('../../research/model-save-fix-2026-10-15/synthetic-model',new Date().toISOString().replaceAll(':','-'));mkdirSync(root,{recursive:true,mode:0o700});
 const helper=new Helper('/never-invoked');const nativeTrap=vi.spyOn(helper,'call').mockImplementation(async()=>{throw Error('FORBIDDEN native call in synthetic diagnostic');});
 const defs=createDesktopTools({helper});const tools=new ToolRegistry().register(taskProgressTool());
 let value='57',reads=0,presses=0,afterReads=0;const approvals:unknown[]=[];const events:AgentEvent[]=[];const requests:{required?:string;tools:string[];calls?:string[]}[]=[];
 for(const name of ['desktop_background_describe','desktop_background_click']){const def=defs.find(t=>t.name===name)!;
  tools.register({name:def.name,description:def.description,parameters:def.parameters,actionClass:def.actionClass,onDemand:'desktop',untrustedOutput:true,...(name.endsWith('click')?{alwaysAsk:true}:{}),
   check:async args=>{if(name.endsWith('click')){const a=args as Record<string,unknown>;if(a.snapshotId!==`synthetic-${reads}`||a.ref!==7||a.label!=='7')return 'Synthetic target mismatch';}return null;},
   preview:async()=> 'SYNTHETIC ONLY: Calculator button7; no native input',
   run:async args=>{if(name.endsWith('describe')){reads++;if(presses)afterReads++;return JSON.stringify({snapshotId:`synthetic-${reads}`,bundleId:'com.apple.calculator',pid:999,processStartedAt:1,windowId:7,windowTitle:'Synthetic Calculator',controlMode:'backgroundStrict',targets:[{ref:7,role:'AXButton',label:'7',backgroundActions:['press']}],inputValues:[value],text:`Display: ${value}`});}expect((args as Record<string,unknown>).label).toBe('7');expect(presses).toBe(0);presses++;value='7';return JSON.stringify({status:'delivered',foregroundChanged:false,operationId:'synthetic-only'});}
  },'desktop');
 }
 const actual=createModel(`vunemi:${config.model}`,{kind:'vunemi',baseUrl:config.baseUrl,apiKey:config.apiKey});
 const model:ChatModel={id:'synthetic-installed-model',chat:async(req,chunk)=>{const record={required:req.toolChoice?.name,tools:req.tools.map(t=>t.name),calls:undefined as string[]|undefined};requests.push(record);const result=await actual.chat(req,chunk);record.calls=result.toolCalls.map(t=>t.name);return result;}};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('Synthetic model diagnostic120s cap')),120000);
 const summary:Record<string,unknown>={method:'real installed model/current source core + synthetic effects only; no installed-model/native/human acceptance',nativeEffects:0,reasoning:'installed default, no thinking override',startedAt:new Date().toISOString()};
 try{
  const result=await runAgent({goal:'Calculator arka planda 7 düğmesine bir kez bas. Ön uygulamanın odağını değiştirme. Önce gerçek desktop_background_describe gözlemini kullan, sonra sonucu yeni gözlemle doğrula.',model,tools,signal:controller.signal,maxSteps:12,planEveryTask:true,requestPlanApproval:async()=>({kind:'go',steps:['Calculator penceresini gözle.','Gözlenen 7 düğmesine bir kez bas.','Yeni gözlemle ekran7 sonucunu doğrula.']}),areas:[{id:'desktop',summary:'Mac windows and background controls'}],shownTools:new Set(),pickAreas:async()=>['desktop'],requestApproval:async p=>{approvals.push({tool:p.tool,args:p.args});return {kind:'approve'};},emit:e=>events.push(e)});
  summary.result=result;expect(presses).toBe(1);expect(afterReads).toBeGreaterThanOrEqual(1);expect(nativeTrap).not.toHaveBeenCalled();expect(requests.some(r=>r.required==='desktop_background_describe')).toBe(true);expect(result.status).toBe('done');expect(approvals).toHaveLength(1);expect(approvals[0]).toMatchObject({tool:'desktop_background_click',args:{label:'7',ref:7}});const completed=tasksFromEvents(events)[0]!;expect(completed.steps).toHaveLength(3);expect(completed.steps.every(step=>step.status==='completed'&&step.evidence==='tool_result')).toBe(true);summary.status='pass';
 }catch(error){summary.status='failed';summary.error=error instanceof Error?error.message:'diagnostic failed';throw error;}finally{clearTimeout(timer);summary.finishedAt=new Date().toISOString();summary.reads=reads;summary.syntheticPresses=presses;summary.afterReads=afterReads;summary.nativeCalls=nativeTrap.mock.calls.length;summary.finalSyntheticValue=value;summary.approvals=approvals;summary.requests=requests;summary.events=events.filter(e=>['tool.proposed','tool.finished','run.finished','task.progress'].includes(e.type));summary.tasks=tasksFromEvents(events).map(t=>({status:t.status,steps:t.steps}));writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});nativeTrap.mockRestore();}
},150000);
