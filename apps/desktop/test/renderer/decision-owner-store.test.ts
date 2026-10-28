import {it,expect,vi,afterEach} from 'vitest';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));
import {useStore} from '../../src/renderer/src/store.js';
afterEach(()=>vi.unstubAllGlobals());
it('preserves captured owner and false backend acknowledgement across all decision channels',async()=>{
 const resolveApproval=vi.fn(async()=>false),resolveHandoff=vi.fn(async()=>false),resolvePlan=vi.fn(async()=>false);
 vi.stubGlobal('window',{vunemi:{resolveApproval,resolveHandoff,resolvePlan}});
 const owner={runId:'old-run',requestId:'old-request'};const store=useStore.getState();
 expect(await store.decide('call',{kind:'approve'},owner)).toBe(false);
 expect(await store.resolveHandoff('call','done',owner)).toBe(false);
 expect(await store.resolvePlan({kind:'cancel'},owner)).toBe(false);
 expect(resolveApproval).toHaveBeenCalledExactlyOnceWith('call',{kind:'approve'},owner);
 expect(resolveHandoff).toHaveBeenCalledExactlyOnceWith('call','done',owner);
 expect(resolvePlan).toHaveBeenCalledExactlyOnceWith({kind:'cancel'},owner);
});
it('does not turn an IPC rejection into an acknowledged decision',async()=>{
 vi.stubGlobal('window',{vunemi:{resolveApproval:async()=>{throw Error('Disconnected');}}});
 await expect(useStore.getState().decide('call',{kind:'reject'},{runId:'r',requestId:'p'})).rejects.toThrow('Disconnected');
});
