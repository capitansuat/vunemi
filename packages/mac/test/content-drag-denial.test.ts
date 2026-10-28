import {it,expect} from 'vitest';
import {Helper} from '../src/helper.js';
import {createDesktopTools} from '../src/tools.js';
import {backgroundCapabilitiesV2} from '../src/background-capabilities.js';
import type {ToolContext,ToolCheckContext} from '@vunemi/agent-core';
const ctx:ToolContext&ToolCheckContext={runId:'content-drag-denial',signal:new AbortController().signal,assertToolActive(){},handoff:async()=>false,offerUndo(){},attach(){}};
// A content-bearing native drag must not inherit the measured slider's authority.
it.each([
 {name:'Finder',bundleId:'com.apple.finder',role:'AXTextField'},
 {name:'TextEdit',bundleId:'com.apple.TextEdit',role:'AXTextArea'},
 {name:'Finder',bundleId:'com.apple.finder',role:'AXSlider'},
 {name:'TextEdit',bundleId:'com.apple.TextEdit',role:'AXSlider'},
])('denies $name $role content drag even with copied slider metadata, before any native preflight/input',async app=>{
 const observation={pid:321,app:app.name,bundleId:app.bundleId,processStartedAt:100,windowId:7,snapshotId:'content-snapshot',controlMode:'backgroundStrict',targets:[],extendedTargets:[{ref:1,role:app.role,label:'Synthetic source',profile:'scope-fixture-slider-v1',actions:['drag'],drag:{kind:'slider',current:25,min:0,max:100,axis:'horizontal',valueTolerance:100/380,geometry:{x:100,y:100,width:402,height:34,thumbX:196,thumbY:109,thumbWidth:20,thumbHeight:16}}}]};
 class Bridge extends Helper{calls:string[]=[];constructor(){super('/unused');}override async permissions(){return {accessibility:true,screenRecording:true,calendars:false,reminders:false};}override async apps(){return [{pid:321,name:app.name,bundleId:app.bundleId,frontmost:false}];}override async call(op:string){this.calls.push(op);if(op==='describe')return structuredClone(observation);throw Error('Unexpected native operation');}}
 const h=new Bridge(),tools=createDesktopTools({helper:h});expect(backgroundCapabilitiesV2(observation)).toBeNull();await tools.find(t=>t.name==='desktop_background_describe')!.run({app:'321',windowId:7},ctx);
 const drag=tools.find(t=>t.name==='desktop_background_drag')!,args={targetId:'content-snapshot:1',value:75};await expect(drag.check!(args,ctx)).rejects.toMatchObject({noInputSent:true});await expect(drag.run(args,ctx)).rejects.toMatchObject({noInputSent:true});expect(h.calls).toEqual(['describe']);
});
