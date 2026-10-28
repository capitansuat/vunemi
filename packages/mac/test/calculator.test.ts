import {it,expect} from 'vitest';
import {createDesktopTools,Helper} from '../src/index.js';
import type {ToolContext} from '@vunemi/agent-core';
const context=(extra:Partial<ToolContext>={}):ToolContext=>({signal:new AbortController().signal,handoff:async()=>false,offerUndo:()=>{},attach:()=>{},...extra});
class CalculatorHelper extends Helper {
 calls:{op:string;args:Record<string,unknown>}[]=[];n=0;clicked:string[]=[];spoof=false;wrong=false;partialClear=false;
 constructor(){super('/unused');}
 override async permissions(){return {accessibility:true,screenRecording:true,calendars:false,reminders:false};}
 override async apps(){return [{name:'Calculator',bundleId:this.spoof?'com.example.fake':'com.apple.calculator',pid:123,frontmost:false}];}
 override async call(op:string,args:Record<string,unknown>={}) {
  this.calls.push({op,args});const labels=['Clear','0','1','2','3','4','5','6','7','8','9','Multiply','Equals'];
  if(op==='describe'){this.n++;return {snapshotId:'s'+this.n,windowId:7,text:labels.map((v,i)=>`[${this.n*100+i}] Button "${v}"`).join('\n')+'\n[999] StaticText "Edit field: '+(this.clicked.at(-1)==='Equals'?(this.wrong?'123':'2,196,317'):(this.partialClear&&this.clicked.length===1?'54×':'0'))+'"',count:14,changed:null};}
  if(op==='click'){expect(args.snapshotId).toBe('s'+this.n);this.clicked.push(labels[Number(args.ref)-this.n*100]!);return {windowId:7,snapshotId:'s'+this.n};}
  throw Error('Unexpected helper operation '+op);
 }
}
it('uses one Calculator action, fresh refs after every click and actual display verification',async()=>{
 const helper=new CalculatorHelper();const tools=createDesktopTools({helper,settleMs:0});const calc=tools.find(t=>t.name==='calculator_multiply');expect(calc).toBeDefined();
 const result=await calc!.run({left:5003,right:439} as never,context());
 expect(helper.clicked).toEqual(['Clear','Clear','5','0','0','3','Multiply','4','3','9','Equals']);expect(result).toContain('2196317');
 expect(helper.calls.filter(c=>c.op==='describe')).toHaveLength(12);
 expect(tools.find(t=>t.name==='desktop_focus')!.actionClass).toBe('read');
});
it('refuses an app with the Calculator name but a different bundle',async()=>{
 const helper=new CalculatorHelper();helper.spoof=true;const calc=createDesktopTools({helper}).find(t=>t.name==='calculator_multiply')!;
 await expect(calc.run({left:5003,right:439} as never,context())).rejects.toThrow(/Calculator/);expect(helper.calls).toHaveLength(0);
});
it('does not report success from a computed expectation if the actual display disagrees',async()=>{
 const helper=new CalculatorHelper();helper.wrong=true;const calc=createDesktopTools({helper,settleMs:0}).find(t=>t.name==='calculator_multiply')!;
 await expect(calc.run({left:5003,right:439} as never,context())).rejects.toThrow(/display|ekran/i);
});

it('stops the bounded action when the connector validity check changes',async()=>{
 const helper=new CalculatorHelper();let checks=0;const calc=createDesktopTools({helper,settleMs:0}).find(t=>t.name==='calculator_multiply')!;
 await expect(calc.run({left:5003,right:439} as never,context({assertToolActive:()=>{if(++checks===3)throw Error('connector changed');}}))).rejects.toThrow(/connector changed/);
 expect(helper.clicked).toEqual(['Clear']);
});

it('clears a pending expression within the same approved action before entering any digits',async()=>{
 const helper=new CalculatorHelper();helper.partialClear=true;const calc=createDesktopTools({helper,settleMs:0}).find(t=>t.name==='calculator_multiply')!;
 const result=await calc.run({left:5003,right:439} as never,context());expect(helper.clicked.slice(0,2)).toEqual(['Clear','Clear']);expect(result).toContain('2196317');
});
