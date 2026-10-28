import { describe, it, expect } from 'vitest';
import { resolveNativeRecipeSlots as resolve } from '../../src/main/native-recipes/slots';
describe('native slots', () => {
    it('requires explicit DST offset and rejects nonexistent local time', () => {
        expect(() => resolve([{ local: '2026-03-29T01:30' }], 'Europe/London', Date.parse('2026-03-28T12:00Z'))).toThrow();
        expect(resolve([{ local: '2026-10-25T01:30' }], 'Europe/London', Date.parse('2026-10-24T12:00Z'))).toEqual({ kind: 'needs-offset', choices: [{ index: 0, offsetMinutes: [0, 60] }] });
        expect(resolve([{ local: '2026-10-25T01:30', offsetMinutes: 60 }], 'Europe/London', Date.parse('2026-10-24T12:00Z'))).toEqual({ kind: 'resolved', ats: [Date.parse('2026-10-25T00:30Z')] });
    });
    it('rejects rollover, duplicates, tight gaps and deadline', () => { for (const slots of [[{ local: '2026-10-20T25:00' }], [{ local: '2026-10-20T12:03' }, { local: '2026-10-20T12:03' }], [{ local: '2026-10-20T12:03' }, { local: '2026-10-20T12:04' }], [{ local: '2026-10-21T12:01' }]])
        expect(() => resolve(slots, 'UTC', Date.parse('2026-10-20T12:00Z'))).toThrow(); });
});
it('accepts four sorted concrete slots and the exact 24-hour boundary',()=>{const now=Date.parse('2026-10-20T12:00Z');expect(resolve([{local:'2026-10-21T12:00'},{local:'2026-10-20T12:06'},{local:'2026-10-20T12:04'},{local:'2026-10-20T12:02'}],'UTC',now)).toEqual({kind:'resolved',ats:[now+120000,now+240000,now+360000,now+86400000]});expect(()=>resolve(Array.from({length:5},(_,i)=>({local:`2026-10-20T12:${String(i*2+2).padStart(2,'0')}`})),'UTC',now)).toThrow();expect(()=>resolve([{local:'2026-10-20T12:02'}],'Invalid/Zone',now)).toThrow();});
