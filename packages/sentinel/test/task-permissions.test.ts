import {it,expect} from 'vitest';
import {Sentinel} from '../src/sentinel.js';
import {DEFAULT_POLICY} from '@vunemi/agent-core';
it('ignores legacy tool grants only when requested, preserving real policy auto',()=>{const sentinel=new Sentinel({policy:{...DEFAULT_POLICY,read:'ask'},grants:new Set(['files_read'])});const request={tool:'files_read',actionClass:'read' as const,args:{path:'/fixture/a.txt'},ignoreSessionGrants:true};expect(sentinel.check(request).kind).toBe('ask');sentinel.setPolicy({...DEFAULT_POLICY,read:'auto'});expect(sentinel.check(request).kind).toBe('allow');});
