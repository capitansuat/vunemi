import {it,expect,vi} from 'vitest';
vi.mock('electron',()=>({app:{},session:{},WebContentsView:class{}}));
const {EmbeddedBrowser,EmbeddedBackend}=await import('../../src/main/embedded-browser.js');
function fixture(){
 const browser=new EmbeddedBrowser();const partition={};const main={id:1};let destroyed=false;
 const capturePage=vi.fn(async(_region:unknown,_options:unknown)=>({toPNG:()=>Buffer.from('synthetic-region')}));
 const child={id:2,session:partition,isDestroyed:()=>destroyed,capturePage};
 const internals=browser as unknown as {win:unknown;ses:unknown;tabs:unknown[];strictPages?:WeakSet<object>};internals.win={isDestroyed:()=>false,webContents:main};internals.ses=partition;internals.tabs.push({id:'2',view:{webContents:child,getBounds:()=>({width:800,height:600})}});internals.strictPages?.add(child);
 return{capturePage,browser,backend:new EmbeddedBackend(browser),internals,child,main,setDestroyed(){destroyed=true;},setUnattested(){internals.strictPages?.delete(child);}};
}
it('attests only the isolated owned browser child with stable host ownership across backend reconnects',async()=>{
 const f=fixture();const a=await f.backend.strictTarget('2');const b=await new EmbeddedBackend(f.browser).strictTarget('2');
 expect(a).toEqual(b);expect(a).toMatchObject({kind:'owned-web-content',protected:false,hostPid:process.pid});expect(a.ownerId).toBeTruthy();
});
it('refuses arbitrary ids and a main approval renderer even if it is mistakenly present in the tab list',async()=>{
 const f=fixture();await expect(f.backend.strictTarget('1')).rejects.toThrow();
 f.internals.tabs.push({id:'1',view:{webContents:f.main}});await expect(f.backend.strictTarget('1')).rejects.toThrow();
});
it('refuses a destroyed, unattested or foreign-session child before strict attachment',async()=>{
 const gone=fixture();gone.setDestroyed();await expect(gone.backend.strictTarget('2')).rejects.toThrow();
 const privileged=fixture();privileged.setUnattested();await expect(privileged.backend.strictTarget('2')).rejects.toThrow();
 const foreign=fixture();foreign.child.session={};await expect(foreign.backend.strictTarget('2')).rejects.toThrow();
});

it('captures only an in-bounds region of the attested child without activating the host',async()=>{
 const f=fixture();expect(await f.backend.captureRegion('2',{x:20.2,y:30.1,width:100.2,height:50.3})).toEqual(Buffer.from('synthetic-region'));
 expect(f.capturePage).toHaveBeenCalledWith({x:20,y:30,width:101,height:51},{stayHidden:true});
});
it('rejects out-of-bounds or unattested regions before capture and revalidates after capture',async()=>{
 const f=fixture();await expect(f.backend.captureRegion('2',{x:-1,y:0,width:20,height:20})).rejects.toThrow();expect(f.capturePage).not.toHaveBeenCalled();
 f.capturePage.mockImplementationOnce(async()=>{f.setDestroyed();return{toPNG:()=>Buffer.from('untrusted-stale')};});
 await expect(f.backend.captureRegion('2',{x:0,y:0,width:20,height:20})).rejects.toThrow();
});
