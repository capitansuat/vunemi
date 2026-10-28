import {it,expect,vi} from 'vitest';
import {PageDriver} from '../src/page.js';
import type {CdpSession} from '../src/cdp.js';
it('settles the exact pressed pointer release even when Stop interrupts a drag',async()=>{
 const calls:{method:string;params?:Record<string,unknown>}[]=[];let release!:()=>void;
 const session={on:()=>()=>{},send:async(method:string,params?:Record<string,unknown>)=>{calls.push({method,params});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};if(params?.type==='mouseReleased')await new Promise<void>(r=>{release=r;});return {};}} as CdpSession;
 const driver=await PageDriver.attach(session);let checks=0;const guard=async()=>{if(++checks===3)throw Error('Stopped');};
 let settled=false;const action=driver.strictPerform({bindingId:'b',action:'drag',ref:1,x:10,y:10,toX:80,toY:10,steps:8},{x:10,y:10},guard).catch(e=>{settled=true;return e;});
 await vi.waitFor(()=>expect(calls.some(c=>c.params?.type==='mouseReleased')).toBe(true));expect(settled).toBe(false);
 release();expect(await action).toMatchObject({message:'Stopped'});
 expect(calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params?.type)).toEqual(['mouseMoved','mousePressed','mouseReleased']);
});
