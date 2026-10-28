import {it,expect,vi} from 'vitest';
import {createBrowserTools} from '../src/tools.js';
import type {BrowserController} from '../src/controller.js';
it('new strict action always asks and takes owner identity only from trusted check context',async()=>{
 const checkBound=vi.fn(async()=>{});const browser={checkBound} as unknown as BrowserController;
 const tool=createBrowserTools(browser).find(t=>t.name==='page_target_act')!;
 expect(tool.alwaysAsk).toBe(true);expect(tool.allowSessionApproval).not.toBe(true);
 const args={bindingId:'opaque',action:'click',ref:1,runId:'forged'};
 await expect(tool.check!(args)).rejects.toThrow(/trusted|owner/i);expect(checkBound).not.toHaveBeenCalled();
 const assertToolActive=vi.fn();await tool.check!(args,{runId:'real',signal:new AbortController().signal,assertToolActive});
 expect(checkBound).toHaveBeenCalledWith(args,'real');expect(assertToolActive).toHaveBeenCalledTimes(1);
});
