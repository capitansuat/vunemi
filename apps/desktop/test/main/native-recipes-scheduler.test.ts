import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeRecipeStore } from '../../src/main/native-recipes/store';
import { NativeRecipeScheduler } from '../../src/main/native-recipes/scheduler';
const epoch = { app: 'b', uid: 501, securitySessionId: 2, policy: 1, roots: 1, connector: 1, helperRevision: '1', timeZone: 'UTC' };
function setup() { vi.spyOn(Date, 'now').mockReturnValue(1000000); const store = new NativeRecipeStore(join(mkdtempSync(join(tmpdir(), 'native-scheduler-')), 'data.json'), epoch); const binding = { target: { path: '/tmp/a.txt', pid: 2, windowId: 3, bundleId: 'com.apple.TextEdit' as const, startSec: '1', startUsec: '2', parentDevice: '1', parentInode: '2' }, version: { device: '1', inode: '3', size: '1', mtimeNs: '1', ctimeNs: '1', sha256: 'abc' }, textUnits: 1, uid: 501, securitySessionId: 2, helperRevision: '1' }; const owner = { setupSessionId: 's', setupCallId: 'c' }; const o = store.offer(owner, binding, { recipeId: 'textedit.append-save.v1', target: binding.target, literal: 'x', timeZone: 'UTC', slots: [] }, [1120000, 1240000], 1000000); store.approve(o.offerId, o.revision, owner); return store; }
afterEach(() => vi.restoreAllMocks());
it('accepts exactly grace boundary once, consumes busy future slot', () => { const store = setup(), run = vi.fn(() => new Promise<void>(() => { })); let now = 1180000; const scheduler = new NativeRecipeScheduler({ store, now: () => now, canStart: () => true, run }); scheduler.tick(); scheduler.tick(); expect(run).toHaveBeenCalledTimes(1); now = 1240000; scheduler.tick(); expect(run).toHaveBeenCalledTimes(1); expect(store.snapshot().recipes[0]!.slots[1]!.status).toBe('skipped'); expect(store.snapshot().recipes[0]!.remainingSlots).toBe(0); });
it('consumes late and busy slots, never catches up after clock back', () => { const store = setup(), run = vi.fn(async () => { }); let now = 1180001; const scheduler = new NativeRecipeScheduler({ store, now: () => now, canStart: () => false, run }); scheduler.tick(); expect(store.snapshot().recipes[0]!.slots[0]!.reason).toBe('missed'); now = 1240000; scheduler.tick(); now = 1120000; scheduler.tick(); expect(run).not.toHaveBeenCalled(); expect(store.snapshot().recipes[0]!.remainingSlots).toBe(0); });
it('blocks future authority when runner resolves without settlement',async()=>{const store=setup();const scheduler=new NativeRecipeScheduler({store,now:()=>1120000,canStart:()=>true,run:async()=>{}});scheduler.tick();await new Promise(resolve=>setImmediate(resolve));expect(store.snapshot().recipes[0]!.slots[0]!.status).toBe('unknown');expect(store.snapshot().recipes[0]!.authorityStatus).toBe('blocked-unknown');});
it('publishes expiry before attempting overdue slot admission', () => {
    const store = setup(), run = vi.fn(async () => {});
    const expiresAt = store.snapshot().recipes[0]!.expiresAt;
    const scheduler = new NativeRecipeScheduler({ store, now: () => expiresAt, canStart: () => true, run });
    scheduler.tick();
    expect(store.snapshot().recipes[0]!.authorityStatus).toBe('expired');
    expect(run).not.toHaveBeenCalled();
});
