import type {ToolContext,ToolDef} from '@vunemi/agent-core';
import type {Helper} from './helper.js';
import {BACKGROUND_ONLY} from './control-mode.js';
type View={text:string;snapshotId:string;windowId:number};
/** One approved, bounded transaction in Apple's actual Calculator window. */
export function calculatorMultiply(helper:Helper,permission:()=>Promise<void>,settleMs:number):ToolDef<{left:number;right:number}> {
 const scopes=new WeakMap<object,string>();
 const valid=(a:{left:number;right:number})=>Number.isSafeInteger(a.left)&&Number.isSafeInteger(a.right)&&a.left>=0&&a.right>=0&&a.left<=999999999&&a.right<=999999999&&Number.isSafeInteger(a.left*a.right);
 return {
  name:'calculator_multiply',description:'Multiply in Calculator; verify its real display.',
  avoidFor:BACKGROUND_ONLY,
  parameters:{type:'object',properties:{left:{type:'integer'},right:{type:'integer'}},required:['left','right']},
  actionClass:'outbound',onDemand:'desktop',wantedFor:/calculator|hesap\s*makinesi/iu,untrustedOutput:true,
  alwaysAsk:true,
  async check(a){
   scopes.delete(a);if(!valid(a))return 'Calculator needs nonnegative safe integers and an exact safe product.';
   await permission();const app=(await helper.apps()).find(app=>app.bundleId.toLowerCase()==='com.apple.calculator');
   if(!app)return 'Open the Apple Calculator application first.';
   const view=await helper.call('describe',{app:String(app.pid),part:'window'}) as {snapshotId:string};
   const identity=await helper.call('validate_snapshot',{app:String(app.pid),snapshotId:view.snapshotId}) as {pid:number;bundleId:string;processStartedAt:number};
   if(identity.pid!==app.pid||identity.bundleId!==app.bundleId||!identity.processStartedAt)return 'Calculator identity unavailable; no input sent.';
   scopes.set(a,`mac-desktop:${identity.bundleId}:${identity.pid}:${identity.processStartedAt}`);return null;
  },
  preview:async a=>`Calculator: ${a.left} × ${a.right}; clear current input, enter and verify the result.`,
  async run(a,ctx:ToolContext){
   if(!valid(a))throw Error('Invalid Calculator operands.');await permission();
   const app=(await helper.apps()).find(app=>app.bundleId.toLowerCase()==='com.apple.calculator');
   if(!app)throw Error('Open the Apple Calculator application first.');
   const approvedScope=scopes.get(a);
   if(approvedScope && !approvedScope.startsWith(`mac-desktop:${app.bundleId}:${app.pid}:`))throw Error('Calculator process changed after approval; no input sent.');
   const active=()=>{if(ctx.signal.aborted)throw ctx.signal.reason??Error('Stopped.');ctx.assertToolActive?.();};
   const observe=async(windowId?:number):Promise<View>=>{active();return await helper.call('describe',{app:String(app.pid),part:'window',...(windowId!==undefined&&{windowId})}) as View;};
   let view=await observe();if(!view.snapshotId||!Number.isInteger(view.windowId))throw Error('Calculator window identity unavailable.');const window=view.windowId;
   const labels=['Clear','Clear',...String(a.left),'Multiply',...String(a.right),'Equals'];
   const aliases:Record<string,string[]>={Clear:['clear','all clear','ac','temizle','tümünü temizle'],Multiply:['multiply','×','çarp','çarpma'],Equals:['equals','=','eşittir']};
   for(const [index,label] of labels.entries()){
    active();if(view.windowId!==window)throw Error('Calculator window changed; no further input sent.');
    const accepted=aliases[label]??[label];
    const buttons=[...view.text.matchAll(/^\s*\[(\d+)\]\s+Button\s+"([^"]+)"\s*$/gm)].filter(m=>accepted.includes(m[2]!.trim().toLocaleLowerCase('tr')));
    if(buttons.length!==1)throw Error(`Calculator button ${label} is unavailable or ambiguous; no guessed input sent.`);
    await helper.call('click',{app:String(app.pid),snapshotId:view.snapshotId,ref:Number(buttons[0]![1]),label:buttons[0]![2]},{signal:ctx.signal,assertActive:ctx.assertToolActive});
    if(settleMs)await new Promise(resolve=>setTimeout(resolve,Math.min(settleMs,80)));view=await observe(window);
    if(label==='Clear'&&index===1){const cleared=[...view.text.matchAll(/^\s*\[\d+\]\s+(?:StaticText|TextField|TextArea)\s+"(?:Edit field|Düzenleme alanı):\s*([^"\n]+)"\s*$/gm)];if(cleared.length!==1||cleared[0]![1]!.replace(/[,\.\s\u00a0\u202f]/g,'')!=='0')throw Error('Calculator did not clear its actual display; no digits entered.');}
   }
   const display=[...view.text.matchAll(/^\s*\[\d+\]\s+(?:StaticText|TextField|TextArea)\s+"(?:Edit field|Düzenleme alanı):\s*([^"\n]+)"\s*$/gm)].map(m=>m[1]!.trim());
   const expected=String(a.left*a.right);
   if(display.length!==1||display[0]!.replace(/[,\.\s\u00a0\u202f]/g,'')!==expected)throw Error(`Calculator display verification failed: ${JSON.stringify(display)}; expected ${expected}.`);
   return JSON.stringify({application:'com.apple.calculator',windowId:window,snapshotId:view.snapshotId,left:a.left,right:a.right,result:expected,actualDisplay:display[0],verified:true});
  },
 };
}
