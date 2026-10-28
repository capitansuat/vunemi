import {it,expect,vi} from 'vitest';
import {softwareUpdatesTool} from '../src/software-updates.js';
import type {ToolContext} from '@vunemi/agent-core';
const ctx=():ToolContext=>({signal:new AbortController().signal,handoff:async()=>true,attach:()=>{},offerUndo:()=>{}});
it('runs only the fixed read-only Apple update query without a shell',async()=>{
 const run=vi.fn().mockResolvedValue({stdout:'Software Update found the following new or updated software:\n* Label: macOS fixture',stderr:''});
 const tool=softwareUpdatesTool(run);const out=await tool.run({},ctx());
 expect(tool.actionClass).toBe('read');expect(run.mock.calls[0]?.slice(0,2)).toEqual(['/usr/sbin/softwareupdate',['--list']]);expect(out).toContain('macOS fixture');
});
it('refuses model-supplied arguments before any process is started',async()=>{
 const run=vi.fn();await expect(softwareUpdatesTool(run).run({args:['--install','--all']},ctx())).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});
it('does not turn empty output or a process failure into no updates',async()=>{
 await expect(softwareUpdatesTool(vi.fn().mockResolvedValue({stdout:'',stderr:''})).run({},ctx())).rejects.toThrow();
 await expect(softwareUpdatesTool(vi.fn().mockRejectedValue(Error('fixture denied'))).run({},ctx())).rejects.toThrow('fixture denied');
});
it('passes cancellation through and does not start after Stop',async()=>{
 const run=vi.fn(),c=ctx();(c.signal as AbortSignal);const controller=new AbortController();controller.abort();c.signal=controller.signal;
 await expect(softwareUpdatesTool(run).run({},c)).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});
