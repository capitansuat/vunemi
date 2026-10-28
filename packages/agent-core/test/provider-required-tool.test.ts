import {afterEach,describe,expect,it,vi} from 'vitest';
import {createModel} from '../src/provider.js';
const tool={name:'read_clock',description:'Read the actual clock',parameters:{type:'object' as const,properties:{timezone:{type:'string' as const}},required:['timezone']}};
const request={messages:[{role:'user' as const,content:'Read the clock.'}],tools:[tool],signal:new AbortController().signal,toolChoice:{name:'read_clock'}};
afterEach(()=>vi.unstubAllGlobals());
describe('required named tool generation',()=>{
 it('serializes a named function requirement without relaxing the actual tool schema',async()=>{
  const fetch=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_clock","arguments":"{\\"timezone\\":\\"UTC\\"}"}}]}}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal('fetch',fetch);
  const result=await createModel('vunemi:test',{kind:'vunemi',baseUrl:'http://127.0.0.1:9000/v1'}).chat(request,()=>{});
  const body=JSON.parse((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body as string);
  expect(body.tool_choice).toEqual({type:'function',function:{name:'read_clock'}});
  expect(body.tools[0].function.parameters).toEqual(tool.parameters);
  expect(result.toolCalls).toEqual([{id:'c1',name:'read_clock',argumentsText:'{"timezone":"UTC"}'}]);
 });
 it('rejects an unavailable required tool before making a provider request',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(createModel('lmstudio:test').chat({...request,tools:[]},()=>{})).rejects.toThrow(/required|tool/i);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('does not silently degrade a required choice on Ollama native',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(createModel('ollama:test').chat(request,()=>{})).rejects.toThrow(/required|support|tool/i);
  expect(fetch).not.toHaveBeenCalled();
 });
});
