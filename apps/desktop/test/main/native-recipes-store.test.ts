import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeRecipeStore } from '../../src/main/native-recipes/store';
export const epoch = { app: 'boot', uid: 501, securitySessionId: 2, policy: 1, roots: 1, connector: 1, helperRevision: '1', timeZone: 'UTC' };
export const binding = { target: { path: '/tmp/a.txt', pid: 2, windowId: 3, bundleId: 'com.apple.TextEdit' as const, startSec: '1', startUsec: '2', parentDevice: '1', parentInode: '2' }, version: { device: '1', inode: '3', size: '1', mtimeNs: '1', ctimeNs: '1', sha256: 'abc' }, textUnits: 1, uid: 501, securitySessionId: 2, helperRevision: '1' };
export const owner = { setupSessionId: 'session', setupCallId: 'call' };
export function fixture() { vi.spyOn(Date, 'now').mockReturnValue(1000000); const file = join(mkdtempSync(join(tmpdir(), 'native-store-')), 'data.json'); const store = new NativeRecipeStore(file, epoch); const offer = store.offer(owner, binding, { recipeId: 'textedit.append-save.v1', target: binding.target, literal: 'X', timeZone: 'UTC', slots: [] }, [1120000, 1240000], 1000000); store.approve(offer.offerId, offer.revision, owner); return { store, file }; }
afterEach(() => vi.restoreAllMocks());
it('reserves once without refund and restart disarms', () => { const { store, file } = fixture(); const r = store.snapshot().recipes[0]!; const c = store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000); expect(() => store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000)).toThrow(); store.skip(c, 'busy'); expect(store.snapshot().recipes[0]!.remainingSlots).toBe(1); const reload = new NativeRecipeStore(file, { ...epoch, app: 'next' }); expect(reload.snapshot().recipes[0]!.authorityStatus).toBe('reapproval-required'); expect(reload.snapshot().recipes[0]!.remainingSlots).toBe(1); expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1); });
it('rejects forged tickets and revoked stale continuations', () => { const { store } = fixture(); expect(() => store.assert({} as never)).toThrow(); const r = store.snapshot().recipes[0]!, c = store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000); store.revoke({ automationId: r.automationId, expectedRevision: store.snapshot().revision }); expect(() => store.linkChild(c, 'append', 'child')).toThrow(); });
it('pins owner, TTL, cancellation and epoch', () => { const { store } = fixture(); const offer = store.offer(owner, binding, { recipeId: 'textedit.append-save.v1', target: binding.target, literal: 'X', timeZone: 'UTC', slots: [] }, [1120000], 1000000); expect(() => store.approve(offer.offerId, offer.revision, { ...owner, setupCallId: 'foreign' })).toThrow(); store.cancelSetup(owner); expect(() => store.approve(offer.offerId, offer.revision, owner)).toThrow(); store.invalidate('policy', { ...epoch, policy: 2 }); expect(store.snapshot().recipes[0]!.authorityStatus).toBe('reapproval-required'); });
it('rejects non-finite claims and forged persisted authority', () => { const { store, file } = fixture(); const r = store.snapshot().recipes[0]!; expect(() => store.claim(r.automationId, r.revision, r.slots[0]!.slotId, NaN)).toThrow(); const raw = JSON.parse(readFileSync(file, 'utf8')); raw.rows[0].view.remainingSlots = 99; require('node:fs').writeFileSync(file, JSON.stringify(raw)); expect(() => new NativeRecipeStore(file, epoch)).toThrow(); });
it('keeps revoked status alongside late unknown evidence', () => { const { store } = fixture(); const r = store.snapshot().recipes[0]!, c = store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000); store.revoke({ automationId: r.automationId, expectedRevision: store.snapshot().revision }); store.complete(c, { status: 'unknown', dispatchIds: [], reasonCode: 'cancelled-unsettled' }); expect(store.snapshot().recipes[0]!.authorityStatus).toBe('revoked'); expect(store.snapshot().recipes[0]!.slots[0]!.status).toBe('unknown'); });
it('poisons admissions on failed atomic publication', () => { const { store, file } = fixture(); const fs = require('node:fs'); fs.unlinkSync(file); fs.mkdirSync(file); const r = store.snapshot().recipes[0]!; expect(() => store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000)).toThrow(); expect(() => store.offer(owner, binding, { recipeId: 'textedit.append-save.v1', target: binding.target, literal: 'x', timeZone: 'UTC', slots: [] }, [1120000], 1000000)).toThrow(); });
it('never accepts a verified after-binding for a different target', () => { const { store } = fixture(); const r = store.snapshot().recipes[0]!, c = store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000); vi.spyOn(Date, 'now').mockReturnValue(1120000); store.recordBackup(c, r.slots[0]!.backupPath, 'backuphash'); store.linkChild(c, 'append', 'append'); expect(() => store.complete(c, { status: 'verified', afterBinding: { ...binding, target: { ...binding.target, path: '/tmp/other.txt' }, textUnits: 2 }, backup: { path: r.slots[0]!.backupPath, sha256: 'backuphash' }, dispatchIds: ['append'] })).toThrow(); });
it('expiry and final approval first-slot grace invalidate offers', () => { const { store } = fixture(); const input = { recipeId: 'textedit.append-save.v1' as const, target: binding.target, literal: 'X', timeZone: 'UTC', slots: [] }; let o = store.offer(owner, { ...binding, target: { ...binding.target, path: '/tmp/b.txt' } }, { ...input, target: { ...binding.target, path: '/tmp/b.txt' } }, [1120000], 1000000); vi.spyOn(Date, 'now').mockReturnValue(1060001); expect(() => store.approve(o.offerId, o.revision, owner)).toThrow(); o = store.offer(owner, binding, input, [1360000], 1000000); vi.spyOn(Date, 'now').mockReturnValue(1120000); expect(() => store.approve(o.offerId, o.revision, owner)).toThrow(); });
it('only two ordered child dispatches, no backup replay and no budget refund', () => { const { store } = fixture(); const r = store.snapshot().recipes[0]!, c = store.claim(r.automationId, r.revision, r.slots[0]!.slotId, 1120000); vi.spyOn(Date, 'now').mockReturnValue(1120000); expect(() => store.linkChild(c, 'append', 'a')).toThrow(); store.recordBackup(c, r.slots[0]!.backupPath, 'backuphash'); expect(() => store.recordBackup(c, r.slots[0]!.backupPath, 'backuphash')).toThrow(); expect(() => store.linkChild(c, 'save', 's')).toThrow(); store.linkChild(c, 'append', 'a'); expect(() => store.linkChild(c, 'append', 'a2')).toThrow(); store.linkChild(c, 'save', 's'); expect(() => store.linkChild(c, 'save', 's2')).toThrow(); store.complete(c, { status: 'unknown', dispatchIds: ['a', 's'] }); expect(store.snapshot().recipes[0]!.remainingSlots).toBe(1); expect(store.snapshot().recipes[0]!.authorityStatus).toBe('blocked-unknown'); expect(() => store.claim(r.automationId, r.revision, r.slots[1]!.slotId, 1240000)).toThrow(); });
it('advances only a verified binding and keeps restart unknown evidence',()=>{const {store,file}=fixture();const r=store.snapshot().recipes[0]!,c=store.claim(r.automationId,r.revision,r.slots[0]!.slotId,1120000);vi.spyOn(Date,'now').mockReturnValue(1120000);store.recordBackup(c,r.slots[0]!.backupPath,'backuphash');store.linkChild(c,'append','append');store.complete(c,{status:'verified',afterBinding:{...binding,textUnits:2,version:{...binding.version,inode:'new',sha256:'after'}},backup:{path:r.slots[0]!.backupPath,sha256:'backuphash'},dispatchIds:['append']});const second=store.claim(r.automationId,r.revision,r.slots[1]!.slotId,1240000);expect(store.inspect(second).binding.version.inode).toBe('new');store.revoke({automationId:r.automationId,expectedRevision:store.snapshot().revision});const reload=new NativeRecipeStore(file,{...epoch,app:'newboot'});expect(reload.snapshot().recipes[0]!.authorityStatus).toBe('revoked');expect(reload.snapshot().recipes[0]!.slots[0]!.status).toBe('verified');expect(reload.snapshot().recipes[0]!.slots[1]!.status).toBe('unknown');});
for (const state of ['active', 'unknown'] as const) {
    for (const alias of ['same-file', 'same-window'] as const) {
        it(`rejects ${alias} aliases while the original target is ${state}`, () => {
            const { store } = fixture();
            if (state === 'unknown') {
                const row = store.snapshot().recipes[0]!;
                const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
                store.complete(claim, { status: 'unknown', dispatchIds: [], reasonCode: 'unsettled' });
            }
            const other = {
                ...binding,
                target: { ...binding.target, path: '/tmp/renamed-or-hardlink.txt', windowId: alias === 'same-file' ? 99 : binding.target.windowId },
                version: { ...binding.version, inode: alias === 'same-window' ? 'another-inode' : binding.version.inode }
            };
            const offer = store.offer(owner, other, {
                recipeId: 'textedit.append-save.v1', target: other.target, literal: 'X', timeZone: 'UTC', slots: []
            }, [1120000], 1000000);
            expect(() => store.approve(offer.offerId, offer.revision, owner)).toThrow('Target has active or unresolved recipe');
            expect(store.snapshot().recipes).toHaveLength(1);
        });
    }
}
it('accepts equivalent native identity with reordered JSON keys', () => {
    const { store } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    vi.spyOn(Date, 'now').mockReturnValue(1120000);
    store.recordBackup(claim, row.slots[0]!.backupPath, 'backuphash');
    store.linkChild(claim, 'append', 'append');
    const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
    expect(() => store.complete(claim, {
        status: 'verified', afterBinding: { ...binding, target: reversed(binding.target), version: reversed({ ...binding.version, inode: 'new-inode', sha256: 'after' }), textUnits: 2 },
        backup: { path: row.slots[0]!.backupPath, sha256: 'backuphash' }, dispatchIds: ['append']
    })).not.toThrow();
    expect(store.snapshot().recipes[0]!.slots[0]!.status).toBe('verified');
});
it('projects only actual backup creation and preserves it across restart', () => {
    const { store, file } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    expect(store.snapshot().recipes[0]!.slots[0]!.backupCreated).toBeUndefined();
    store.recordBackup(claim, row.slots[0]!.backupPath, 'verified-backup');
    expect(store.snapshot().recipes[0]!.slots[0]!.backupCreated).toBe(true);
    const reload = new NativeRecipeStore(file, { ...epoch, app: 'restarted' });
    expect(reload.snapshot().recipes[0]!.slots[0]!.backupCreated).toBe(true);
    expect(reload.snapshot().recipes[0]!.slots[1]!.backupCreated).toBeUndefined();
});
it('retains actual unverified backup-only creation without inventing verified backup evidence', () => {
    const { store, file } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    store.complete(claim, { status: 'backup-only', dispatchIds: [], backup: { path: row.slots[0]!.backupPath, sha256: 'partial-file-hash' }, reasonCode: 'backup-invalid' });
    expect(store.snapshot().recipes[0]!.slots[0]!.backupCreated).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).rows[0].backups).toEqual({});
    const reload = new NativeRecipeStore(file, { ...epoch, app: 'restarted' });
    expect(reload.snapshot().recipes[0]!.slots[0]!.backupCreated).toBe(true);
});
it('does not invent actual backup creation for unknown without backup', () => {
    const { store } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    store.complete(claim, { status: 'unknown', dispatchIds: [] });
    expect(store.snapshot().recipes[0]!.slots[0]!.backupCreated).toBeUndefined();
});
it('expires active authority and stale claims at the exact deadline', () => {
    const { store, file } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    store.expire(row.expiresAt);
    expect(store.snapshot().recipes[0]!.authorityStatus).toBe('expired');
    expect(() => store.assert(claim)).toThrow();
    const revision = store.snapshot().revision;
    store.expire(row.expiresAt + 1);
    expect(store.snapshot().revision).toBe(revision);
    expect(JSON.parse(readFileSync(file, 'utf8')).rows[0].view.authorityStatus).toBe('expired');
});
it('accepts proven native pre-effect rejection as backup-only despite linked child', () => {
    const { store } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    vi.spyOn(Date, 'now').mockReturnValue(1120000);
    store.recordBackup(claim, row.slots[0]!.backupPath, 'backuphash');
    store.linkChild(claim, 'append', 'rejected-child');
    store.complete(claim, { status: 'backup-only', dispatchIds: ['rejected-child'], noInputSent: true, backup: { path: row.slots[0]!.backupPath, sha256: 'backuphash' }, reasonCode: 'native-precondition' });
    expect(store.snapshot().recipes[0]!.slots[0]!.status).toBe('backup-only');
    expect(store.snapshot().recipes[0]!.authorityStatus).toBe('reapproval-required');
});
it('target drift ends remaining authority', () => {
    const { store } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    store.complete(claim, { status: 'no-input', dispatchIds: [], reasonCode: 'target-drift' });
    expect(store.snapshot().recipes[0]!.authorityStatus).toBe('reapproval-required');
    expect(() => store.claim(row.automationId, row.revision, row.slots[1]!.slotId, 1240000)).toThrow();
});
it('restores unresolved target bindings even with no child dispatch', () => {
    const { store, file } = fixture();
    const row = store.snapshot().recipes[0]!;
    const claim = store.claim(row.automationId, row.revision, row.slots[0]!.slotId, 1120000);
    store.complete(claim, { status: 'unknown', dispatchIds: [], reasonCode: 'unsettled' });
    const reload = new NativeRecipeStore(file, { ...epoch, app: 'restarted' });
    expect(reload.unresolvedBindings()).toEqual([{ runId: row.slots[0]!.runId ?? store.snapshot().recipes[0]!.slots[0]!.runId, binding }]);
});
it('expired setup offers cannot revive after clock moves backward', () => {
    const { store } = fixture();
    const other = { ...binding, target: { ...binding.target, path: '/tmp/new-target.txt', windowId: 100 }, version: { ...binding.version, inode: 'different-file' } };
    const offer = store.offer(owner, other, { recipeId: 'textedit.append-save.v1', target: other.target, literal: 'X', timeZone: 'UTC', slots: [] }, [1360000], 1000000);
    store.expire(offer.expiresAt);
    expect(() => store.approve(offer.offerId, offer.revision, owner)).toThrow('Stale recipe offer');
});
