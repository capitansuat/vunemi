import {expect,it,vi} from 'vitest';
import {createCalendarTools} from '../src/calendar.js';
const original={id:'event-1',calendarId:'calendar-1',calendar:'Synthetic',title:'Synthetic',start:'2026-11-01T10:00:00Z',end:'2026-11-01T11:00:00Z',allDay:false};
function fixture(change:Record<string,unknown>={},readError=false){
 let written=false;const receipt=vi.fn();const abort=new AbortController();
 const call=vi.fn(async(op:string,args:any)=>{
  if(op==='events')return {events:[]};
  if(op==='event_create'){written=true;return {...original};}
  if(op==='event_update'){written=true;return {before:{...original},after:{...original,title:args.title}};}
  if(op==='event_get'){if(written&&readError)throw Error('read unavailable');return {...original,...(written?change:{})};}
  throw Error('unexpected '+op);
 });
 const tools=createCalendarTools({helper:{permissions:async()=>({calendars:true}),call} as any});
 const ctx:any={signal:abort.signal,offerUndo:vi.fn(),produced:vi.fn(),recordOutcomeEvidence:receipt,assertToolActive(){if(abort.signal.aborted)throw Error('stopped');}};
 return {tools,ctx,call,receipt,abort};
}
const args={title:'Synthetic',start:original.start,end:original.end};
it('records create proof only after a separate exact ID read with bound calendar and matching fields',async()=>{
 const f=fixture();await f.tools.find(t=>t.name==='calendar_create')!.run(args,f.ctx);
 expect(f.call.mock.calls.map(c=>c[0])).toEqual(['events','event_create','event_get']);
 expect(f.receipt).toHaveBeenCalledOnce();expect(f.receipt.mock.calls[0]![0]).toMatchObject({domain:'calendar',kind:'event-created',targetId:'event-1',source:'controller-readback'});
 const proof=f.receipt.mock.calls[0]![0];expect(proof.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(proof.observedHash).toBe(proof.requestHash);expect(JSON.stringify(proof)).not.toContain('Synthetic');
});
it.each([{id:'other'},{calendarId:'other'},{title:'other'},{start:'2026-11-02T10:00:00Z'},{end:'2026-11-01T12:00:00Z'},{location:'unexpected'},{notes:'unexpected'},{allDay:true}])('does not certify mismatched create readback %j',async change=>{
 const f=fixture(change);const out=await f.tools.find(t=>t.name==='calendar_create')!.run(args,f.ctx);
 expect(f.receipt).not.toHaveBeenCalled();expect(out).toContain('not independently verified');expect(f.call.mock.calls.filter(c=>c[0]==='event_create')).toHaveLength(1);
});
it('keeps an acknowledged write unverified on readback error without retrying it',async()=>{
 const f=fixture({},true);const out=await f.tools.find(t=>t.name==='calendar_create')!.run(args,f.ctx);
 expect(out).toContain('not independently verified');expect(f.receipt).not.toHaveBeenCalled();expect(f.call.mock.calls.filter(c=>c[0]==='event_create')).toHaveLength(1);
});
it('does not certify update from the write response when fresh readback disagrees',async()=>{
 const f=fixture();const out=await f.tools.find(t=>t.name==='calendar_update')!.run({id:'event-1',title:'Changed'},f.ctx);
 expect(f.receipt).not.toHaveBeenCalled();expect(out).toContain('not independently verified');expect(f.call.mock.calls.map(c=>c[0])).toEqual(['event_get','event_update','event_get']);
});
it('certifies an update only from its new exact ID readback',async()=>{
 const f=fixture({title:'Changed'});await f.tools.find(t=>t.name==='calendar_update')!.run({id:'event-1',title:'Changed'},f.ctx);
 expect(f.receipt).toHaveBeenCalledOnce();expect(f.receipt.mock.calls[0]![0]).toMatchObject({kind:'event-updated',targetId:'event-1'});
});
it('does not certify or reread after Stop arrives during the acknowledged creation',async()=>{
 const f=fixture();const original=f.call.getMockImplementation()!;
 f.call.mockImplementation(async(op,args)=>{const result=await original(op,args);if(op==='event_create')f.abort.abort();return result;});
 const out=await f.tools.find(t=>t.name==='calendar_create')!.run(args,f.ctx);
 expect(out).toContain('not independently verified');expect(f.receipt).not.toHaveBeenCalled();expect(f.call.mock.calls.map(call=>call[0])).toEqual(['events','event_create']);
});
it('does not certify a different requested calendar even if write and read responses agree with each other',async()=>{
 const f=fixture();const out=await f.tools.find(t=>t.name==='calendar_create')!.run({...args,calendar:'different-calendar'},f.ctx);
 expect(f.receipt).not.toHaveBeenCalled();expect(out).toContain('not independently verified');
});
it('refuses a mismatched event identity before any update effect',async()=>{
 const f=fixture();await expect(f.tools.find(t=>t.name==='calendar_update')!.run({id:'other',title:'Changed'},f.ctx)).rejects.toThrow('Nothing was changed');
 expect(f.call.mock.calls.map(call=>call[0])).toEqual(['event_get']);expect(f.receipt).not.toHaveBeenCalled();
});
