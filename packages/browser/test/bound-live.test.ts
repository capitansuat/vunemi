/** Real owned headless Chromium + CDP. Controlled host observer is NOT real OS-focus proof. */
import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchIsolatedChrome} from '../src/chrome.js';
import {BrowserController} from '../src/controller.js';
import type {CdpSession} from '../src/cdp.js';
import {HTML} from './fixtures/bound-page.js';
const value=async<T>(s:CdpSession,expression:string)=>(await s.send<{result:{value:T}}>('Runtime.evaluate',{expression,returnByValue:true})).result.value;
it.skipIf(process.env.VUNEMI_BOUND_BROWSER_LIVE!=='1')('owned Chromium bound click/menu/scroll/canvas drag with actual DOM readback',async()=>{
 const evidence=resolve('../../research/vun12-expansion-2026-10-15/browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(evidence,{recursive:true});
 const nativeHelper=process.env.VUNEMI_BOUND_NATIVE_HELPER;
 const hosts:Array<{foregroundPid:number;cursor:{x:number;y:number};unlocked:boolean}>=[];
 const observeHost=async()=>{
  if(!nativeHelper)return {foregroundPid:999999,cursor:{x:0,y:0},unlocked:true};
  const raw=execFileSync(nativeHelper,[],{input:JSON.stringify({id:1,op:'background_environment',args:{}})+'\n',timeout:5000,maxBuffer:65536,encoding:'utf8'});
  const response=JSON.parse(raw.trim()),e=response.result;
  if(response.ok!==true||e?.verified!==true||e.unlocked!==true||!Number.isSafeInteger(e.foregroundPid)||!Number.isFinite(e.cursor?.x)||!Number.isFinite(e.cursor?.y)){writeFileSync(join(evidence,'blocked.json'),JSON.stringify({status:'blocked',method:'scratch native background_environment',browserInputs:0,reason:'unverified-or-locked',verified:e?.verified,unlocked:e?.unlocked},null,2));throw Error('Native host environment is unverified or locked; no browser input permitted.');}
  const host={foregroundPid:e.foregroundPid,cursor:{x:e.cursor.x,y:e.cursor.y},unlocked:true};hosts.push(host);return host;
 };
 const initialHost=await observeHost();
 const backend=await launchIsolatedChrome({userDataDir:mkdtempSync(join(tmpdir(),'bound-live-')),headless:true});
 const tabs=await backend.listTabs(),target=tabs[0]!.targetId,s=await backend.attach(target);
 await s.send('Page.enable');const {frameTree}=await s.send<{frameTree:{frame:{id:string}}}>('Page.getFrameTree');await s.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:HTML});
 const browser=new BrowserController(async()=>backend,()=>new Set(),{operationJournalPath:join(evidence,'journal.jsonl'),observeHost});
 const receipts:unknown[]=[];try{
  await browser.tabs();
  async function act(action:'click'|'menu'|'scroll'|'drag',label:string,extra={}){
   const observed=await browser.observeBound('owned-live');const line=observed.readback.text.split('\n').find(line=>line.includes(label)&&/\[\d+\]/.test(line));expect(line).toBeTruthy();const ref=Number(/\[(\d+)\]/.exec(line!)?.[1]);expect(ref).toBeGreaterThan(0);
   if(action==='drag'||'x' in extra)await browser.boundScreenshot(observed.bindingId,'owned-live',evidence);
   const args={bindingId:observed.bindingId,action,ref,...extra};await browser.checkBound(args,'owned-live');const receipt=await browser.actBound(args,{runId:'owned-live',signal:new AbortController().signal});receipts.push(receipt);return receipt;
  }
  await s.send('Runtime.evaluate',{expression:`(()=>{const f=document.createElement('iframe');f.srcdoc='<button>Frame fixture button</button>';document.body.append(f)})()`});
  await new Promise(r=>setTimeout(r,200));
  const frameObs=await browser.observeBound('owned-live'),frameLine=frameObs.readback.text.split('\n').find(line=>line.includes('Frame fixture button')&&/\[\d+\]/.test(line));expect(frameLine).toBeTruthy();
  const frameArgs={bindingId:frameObs.bindingId,action:'click' as const,ref:Number(/\[(\d+)\]/.exec(frameLine!)?.[1])};await expect(browser.checkBound(frameArgs,'owned-live')).rejects.toThrow(/main-frame/i);
  await act('click','Fixture button');expect(await value(s,"document.querySelector('#status').textContent")).toBe('Clicked once');
  await act('menu','Fixture menu item');expect(await value(s,"document.querySelector('#status').textContent")).toBe('Menu selected');
  const scroll=await act('scroll','Synthetic scroll log',{delta:180});expect(await value<number>(s,"document.querySelector('textarea').scrollTop")).toBeGreaterThan(0);expect(scroll.readback.target).toMatchObject({scrollTop:180});
  const box=await value<{x:number;y:number}>(s,"(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return{x:r.left+document.querySelector('canvas').clientLeft,y:r.top+document.querySelector('canvas').clientTop}})()");
  await act('click','Synthetic draggable canvas',{x:box.x+60,y:box.y+75});expect(await value(s,"document.querySelector('#canvas-clicks').textContent")).toBe('Canvas clicks 1');
  await act('drag','Synthetic draggable canvas',{x:box.x+60,y:box.y+75,toX:box.x+220,toY:box.y+75,steps:8});expect(await value(s,"document.querySelector('#canvas-status').textContent")).toBe('Canvas x 220');
  const dom=await browser.observeBound('owned-live');
  const refFor=(label:string)=>Number(/\[(\d+)\]/.exec(dom.readback.text.split('\n').find(line=>line.includes(label)&&/\[\d+\]/.test(line))!)?.[1]);
  const domArgs={bindingId:dom.bindingId,action:'drag' as const,ref:refFor('Fixture DOM drag source'),toRef:refFor('Fixture DOM drop target'),steps:12};
  await browser.checkBound(domArgs,'owned-live');receipts.push(await browser.actBound(domArgs,{runId:'owned-live',signal:new AbortController().signal}));
  expect(await value(s,"document.querySelector('#dom-status').textContent")).toBe('Actual DOM dropped');
  const final=await browser.observeBound('owned-live');const image=await browser.boundScreenshot(final.bindingId,'owned-live',evidence);
  const finalHost=await observeHost();expect(finalHost).toEqual(initialHost);if(nativeHelper)expect(hosts.every(host=>JSON.stringify(host)===JSON.stringify(initialHost))).toBe(true);
  writeFileSync(join(evidence,'summary.json'),JSON.stringify({status:'pass',method:nativeHelper?'actual owned headless Chromium/CDP + scratch native background_environment; not installed/model acceptance':'actual owned headless Chromium/CDP; controlled host observer, not installed/native-focus acceptance',initialHost,finalHost,hostObservations:hosts,receipts,image},null,2));
 }finally{await browser.releaseRun('owned-live');await browser.dispose();}
},60000);
