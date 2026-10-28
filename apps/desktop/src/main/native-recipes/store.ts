import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SetupOwner, NativeRecipeSetupInput, NativeRecipeOffer, NativeRecipeView, NativeRecipesSnapshot } from '../../shared/native-recipes';
import type { NativeRecipeBinding, NativeRecipeEpoch, NativeRecipeClaim, NativeRecipeSlotResult } from './types';
type Row = {
    view: NativeRecipeView;
    binding: NativeRecipeBinding;
    epoch: NativeRecipeEpoch;
    generation: number;
    firstEffects: Record<string, number>;
    backups: Record<string, {
        path: string;
        hash: string;
    }>;
};
type Aggregate = {
    version: 1;
    revision: number;
    rows: Row[];
};
type Offer = {
    public: NativeRecipeOffer;
    binding: NativeRecipeBinding;
    epoch: NativeRecipeEpoch;
};
type Ticket = {
    id: string;
    slotId: string;
    generation: number;
    runId: string;
};
const clone = <T>(x: T): T => structuredClone(x);
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
function validateAggregate(d: Aggregate): void {
    const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
    const keys = (x: unknown, required: string[], optional: string[] = []) => { if (!obj(x) || required.some(k => !Object.hasOwn(x, k)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k)))
        throw Error('Invalid native recipe aggregate fields'); };
    const str = (x: unknown) => typeof x === 'string' && x.length > 0;
    const uint = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
    keys(d, ['version', 'revision', 'rows']);
    if (d.version !== 1 || !uint(d.revision) || !Array.isArray(d.rows))
        throw Error('Invalid native recipe aggregate');
    const ids = new Set<string>();
    for (const r of d.rows) {
        keys(r, ['view', 'binding', 'epoch', 'generation', 'firstEffects', 'backups']);
        keys(r.view, ['automationId', 'revision', 'recipeId', 'title', 'target', 'literal', 'timeZone', 'authorityStatus', 'remainingSlots', 'expiresAt', 'slots']);
        const v = r.view;
        if (!str(v.automationId) || ids.has(v.automationId) || !uint(v.revision) || v.revision < 1 || v.recipeId !== 'textedit.append-save.v1' || typeof v.title !== 'string' || typeof v.literal !== 'string' || v.literal.length < 1 || v.literal.length > 256 || !str(v.timeZone) || !['active', 'revoked', 'expired', 'reapproval-required', 'blocked-unknown', 'exhausted'].includes(v.authorityStatus) || !uint(v.remainingSlots) || !uint(v.expiresAt) || !Array.isArray(v.slots) || v.slots.length < 1 || v.slots.length > 4 || !uint(r.generation) || !obj(r.firstEffects) || !obj(r.backups))
            throw Error('Invalid native recipe authority');
        ids.add(v.automationId);
        keys(v.target, ['path', 'pid', 'windowId', 'title']);
        if (!str(v.target.path) || !uint(v.target.pid) || v.target.pid === 0 || !uint(v.target.windowId) || typeof v.target.title !== 'string')
            throw Error('Invalid native target');
        keys(r.epoch, ['app', 'uid', 'securitySessionId', 'policy', 'roots', 'connector', 'helperRevision', 'timeZone']);
        for (const k of ['app', 'helperRevision', 'timeZone'] as const)
            if (!str(r.epoch[k]))
                throw Error('Invalid native epoch');
        for (const k of ['uid', 'securitySessionId', 'policy', 'roots', 'connector'] as const)
            if (!uint(r.epoch[k]))
                throw Error('Invalid native epoch');
        keys(r.binding, ['target', 'version', 'textUnits', 'uid', 'securitySessionId', 'helperRevision']);
        keys(r.binding.target, ['path', 'pid', 'windowId', 'bundleId', 'startSec', 'startUsec', 'parentDevice', 'parentInode']);
        keys(r.binding.version, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'sha256']);
        const b = r.binding;
        if (!uint(b.textUnits) || b.textUnits > 2000 || !uint(b.uid) || !uint(b.securitySessionId) || !str(b.helperRevision) || b.target.bundleId !== 'com.apple.TextEdit' || b.target.path !== v.target.path || b.target.pid !== v.target.pid || b.target.windowId !== v.target.windowId)
            throw Error('Invalid native binding');
        for (const k of ['startSec', 'startUsec', 'parentDevice', 'parentInode'] as const)
            if (!str(b.target[k]))
                throw Error('Invalid native identity');
        for (const k of ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'sha256'] as const)
            if (!str(b.version[k]))
                throw Error('Invalid native version');
        const slots = new Set<string>();
        let remaining = 0;
        for (const [index, slot] of v.slots.entries()) {
            keys(slot, ['slotId', 'at', 'backupPath', 'status', 'dispatchIds'], ['reason', 'runId', 'backupCreated']);
            if (!str(slot.slotId) || slots.has(slot.slotId) || !uint(slot.at) || (index > 0 && slot.at - v.slots[index - 1]!.at < 120000) || slot.backupPath !== b.target.path + '.vunemi-before-scheduled-' + slot.slotId || !['scheduled', 'reserved', 'skipped', 'backup-only', 'verified', 'unknown'].includes(slot.status) || !Array.isArray(slot.dispatchIds) || slot.dispatchIds.length > 2 || slot.dispatchIds.some(id => !str(id)) || new Set(slot.dispatchIds).size !== slot.dispatchIds.length || (slot.reason !== undefined && typeof slot.reason !== 'string') || (slot.runId !== undefined && !str(slot.runId)) || (slot.backupCreated !== undefined && typeof slot.backupCreated !== 'boolean'))
                throw Error('Invalid native slot');
            slots.add(slot.slotId);
            if (slot.status === 'scheduled')
                remaining++;
        }
        if (remaining !== v.remainingSlots)
            throw Error('Invalid native recipe budget');
        for (const [id, time] of Object.entries(r.firstEffects))
            if (!slots.has(id) || !uint(time))
                throw Error('Invalid native dispatch timestamp');
        for (const [id, backup] of Object.entries(r.backups)) {
            keys(backup, ['path', 'hash']);
            if (!slots.has(id) || !str(backup.hash) || backup.path !== v.slots.find(s => s.slotId === id)?.backupPath)
                throw Error('Invalid backup evidence');
        }
    }
}
/** Path aliases must not evade a live or unresolved actual-target authority. */
function sameActualTarget(a: NativeRecipeBinding, b: NativeRecipeBinding): boolean {
    return a.target.path === b.target.path
        || (a.version.device === b.version.device && a.version.inode === b.version.inode)
        || (a.uid === b.uid && a.securitySessionId === b.securitySessionId
            && a.target.bundleId === b.target.bundleId
            && a.target.pid === b.target.pid
            && a.target.startSec === b.target.startSec
            && a.target.startUsec === b.target.startUsec
            && a.target.windowId === b.target.windowId);
}
export class NativeRecipeStore {
    private data: Aggregate = { version: 1, revision: 0, rows: [] };
    private offers = new Map<string, Offer>();
    private tickets = new WeakMap<NativeRecipeClaim, Ticket>();
    private poisoned = false;
    constructor(private file: string, private epoch: NativeRecipeEpoch, private onChanged?: (s: NativeRecipesSnapshot) => void) {
        this.epoch = clone(epoch);
        if (existsSync(file)) {
            const d = JSON.parse(readFileSync(file, 'utf8')) as Aggregate;
            validateAggregate(d);
            this.data = d;
            for (const r of d.rows) {
                if (r.view.authorityStatus === 'active') {
                    r.view.authorityStatus = 'reapproval-required';
                    r.generation++;
                }
                for (const s of r.view.slots)
                    if (s.status === 'reserved') {
                        s.status = 'unknown';
                        s.reason = 'restart-unsettled';
                        if (r.view.authorityStatus !== 'revoked') r.view.authorityStatus = 'blocked-unknown';
                    }
            }
            this.commit();
        }
    }
    unresolvedBindings(){return this.data.rows.flatMap(r=>r.view.slots.filter(s=>s.status==='reserved'||s.status==='unknown').map(s=>({runId:s.runId??'native-unknown',binding:clone(r.binding)})));}
    snapshot(): NativeRecipesSnapshot { return clone({ streamId: this.epoch.app, revision: this.data.revision, recipes: this.data.rows.map(r => r.view) }); }
    private ready() { if (this.poisoned)
        throw Error('Native recipe persistence unavailable'); }
    private commit() { this.ready(); this.data.revision++; let fd: number | undefined; try {
        validateAggregate(this.data);
        mkdirSync(dirname(this.file), { recursive: true });
        const temp = this.file + '.' + randomUUID() + '.tmp';
        fd = openSync(temp, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(this.data));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, this.file);
        fd = openSync(dirname(this.file), 'r');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
    }
    catch (e) {
        this.poisoned = true;
        if (fd !== undefined)
            try {
                closeSync(fd);
            }
            catch { }
        throw e;
    } try {
        this.onChanged?.(this.snapshot());
    }
    catch { /* Observers cannot undo a durable admission. */ } }
    offer(owner: SetupOwner, binding: NativeRecipeBinding, input: NativeRecipeSetupInput, ats: number[], now: number, targetTitle?: string): NativeRecipeOffer {
        this.ready();
        if (!Number.isFinite(now) || !owner.setupSessionId || !owner.setupCallId || input.recipeId !== 'textedit.append-save.v1' || input.literal.length < 1 || input.literal.length > 256 || binding.textUnits + input.literal.length * ats.length > 2000 || input.timeZone !== this.epoch.timeZone || binding.uid !== this.epoch.uid || binding.securitySessionId !== this.epoch.securitySessionId || binding.helperRevision !== this.epoch.helperRevision || input.target.path !== binding.target.path || input.target.pid !== binding.target.pid || input.target.windowId !== binding.target.windowId)
            throw Error('Invalid recipe offer');
        if (ats.length < 1 || ats.length > 4 || ats.some((a, i) => !Number.isFinite(a) || a < now + 120000 || a > now + 86400000 || (i > 0 && a - ats[i - 1]! < 120000)))
            throw Error('Invalid recipe slots');
        this.cancelSetup(owner);
        const offer: NativeRecipeOffer = { ...clone(owner), offerId: randomUUID(), revision: this.data.revision + 1, expiresAt: now + 120000, recipeId: input.recipeId, target: { path: binding.target.path, pid: binding.target.pid, windowId: binding.target.windowId, title: targetTitle ?? binding.target.path.split('/').pop() ?? 'TextEdit' }, literal: input.literal, timeZone: input.timeZone, slots: ats.map(at => { const slotId = randomUUID(); return { slotId, at, backupPath: binding.target.path + '.vunemi-before-scheduled-' + slotId }; }), authorityExpiresAt: now + 86400000 };
        this.offers.set(offer.offerId, { public: clone(offer), binding: clone(binding), epoch: clone(this.epoch) });
        return clone(offer);
    }
    cancelSetup(owner: SetupOwner) { for (const [id, o] of this.offers)
        if (same({ setupSessionId: o.public.setupSessionId, setupCallId: o.public.setupCallId }, owner))
            this.offers.delete(id); }
    approve(id: string, revision: number, owner: SetupOwner): NativeRecipesSnapshot {
        this.ready();
        const o = this.offers.get(id), now = Date.now();
        if (!o || o.public.revision !== revision || o.public.setupSessionId !== owner.setupSessionId || o.public.setupCallId !== owner.setupCallId || !same(o.epoch, this.epoch) || now >= o.public.expiresAt || o.public.slots.some(s => s.at < now + 60000))
            throw Error('Stale recipe offer');
        if (this.data.rows.some(r => sameActualTarget(r.binding, o.binding) && (r.view.authorityStatus === 'active' || r.view.authorityStatus === 'blocked-unknown' || r.view.slots.some(s => s.status === 'reserved' || s.status === 'unknown'))))
            throw Error('Target has active or unresolved recipe');
        const p = o.public;
        this.offers.delete(id);
        this.data.rows.push({ binding: clone(o.binding), epoch: clone(o.epoch), generation: 1, firstEffects: {}, backups: {}, view: { automationId: randomUUID(), revision: 1, recipeId: p.recipeId, title: p.target.title, target: clone(p.target), literal: p.literal, timeZone: p.timeZone, authorityStatus: 'active', remainingSlots: p.slots.length, expiresAt: p.authorityExpiresAt, slots: p.slots.map(s => ({ ...s, status: 'scheduled', dispatchIds: [] })) } });
        this.commit();
        return this.snapshot();
    }
    /** Expiry is a durable authority transition, even if no slot is currently claimable. */
    expire(now: number): void {
        this.ready();
        if (!Number.isFinite(now)) throw Error('Invalid recipe expiry time');
        for (const [id, offer] of this.offers) {
            if (now >= offer.public.expiresAt || now >= offer.public.authorityExpiresAt) this.offers.delete(id);
        }
        let changed = false;
        for (const row of this.data.rows) {
            if (row.view.authorityStatus === 'active' && now >= row.view.expiresAt) {
                row.view.authorityStatus = 'expired';
                row.generation++;
                changed = true;
            }
        }
        if (changed) this.commit();
    }
    claim(id: string, revision: number, slotId: string, now: number): NativeRecipeClaim { this.ready(); const r = this.data.rows.find(r => r.view.automationId === id), s = r?.view.slots.find(s => s.slotId === slotId); if (!r || !s || r.view.revision !== revision || r.view.authorityStatus !== 'active' || !same(r.epoch, this.epoch) || s.status !== 'scheduled' || r.view.remainingSlots < 1 || !Number.isFinite(now) || now < s.at)
        throw Error('Recipe slot unavailable'); if (now >= r.view.expiresAt) {
        r.view.authorityStatus = 'expired';
        r.generation++;
        this.commit();
        throw Error('Recipe expired');
    } s.status = 'reserved'; s.runId = randomUUID(); r.view.remainingSlots--; this.commit(); const claim = Object.freeze({}) as NativeRecipeClaim; this.tickets.set(claim, { id, slotId, generation: r.generation, runId: s.runId }); return claim; }
    private resolve(claim: NativeRecipeClaim, active = true) { this.ready(); const t = this.tickets.get(claim); if (!t)
        throw Error('Forged recipe claim'); const r = this.data.rows.find(r => r.view.automationId === t.id), s = r?.view.slots.find(s => s.slotId === t.slotId); if (!r || !s || s.status !== 'reserved' || (active && (t.generation !== r.generation || r.view.authorityStatus !== 'active' || !same(r.epoch, this.epoch) || Date.now() >= r.view.expiresAt)))
        throw Error('Stale recipe claim'); return { t, r, s }; }
    assert(claim: NativeRecipeClaim) { this.resolve(claim); }
    inspect(claim: NativeRecipeClaim) { const { t, r, s } = this.resolve(claim); return clone({ automationId: t.id, slotId: t.slotId, runId: t.runId, binding: r.binding, literal: r.view.literal, backupPath: s.backupPath, expiresAt: r.view.expiresAt, firstNativeEffectAt: r.firstEffects[s.slotId] ?? null }); }
    skip(claim: NativeRecipeClaim, reason: string) { const { r, s } = this.resolve(claim); if (s.dispatchIds.length || r.backups[s.slotId])
        throw Error('Cannot skip after side effect evidence'); s.status = 'skipped'; s.reason = reason; if (!r.view.remainingSlots && !r.view.slots.some(s => s.status === 'reserved'))
        r.view.authorityStatus = 'exhausted'; this.commit(); }
    linkChild(claim: NativeRecipeClaim, phase: 'append' | 'save', dispatchId: string) { const { r, s } = this.resolve(claim); if (!dispatchId || s.dispatchIds.includes(dispatchId) || (phase === 'append' ? s.dispatchIds.length !== 0 : s.dispatchIds.length !== 1) || !r.backups[s.slotId])
        throw Error('Invalid recipe child'); const now = Date.now(), first = r.firstEffects[s.slotId]; if (now > s.at + 60000 && first === undefined || first !== undefined && now > first + 30000)
        throw Error('Recipe dispatch deadline'); s.dispatchIds.push(dispatchId); if (phase === 'append')
        r.firstEffects[s.slotId] = now; this.commit(); }
    recordBackup(claim: NativeRecipeClaim, path: string, hash: string) { const { r, s } = this.resolve(claim); if (path !== s.backupPath || !hash || r.backups[s.slotId] || s.dispatchIds.length)
        throw Error('Invalid recipe backup'); r.backups[s.slotId] = { path, hash }; s.backupCreated = true; this.commit(); }
    complete(claim: NativeRecipeClaim, result: NativeRecipeSlotResult) {
        const { r, s, t } = this.resolve(claim, false);
        const stale = t.generation !== r.generation || r.view.authorityStatus !== 'active';
        if (!same(result.dispatchIds, s.dispatchIds))
            throw Error('Child evidence mismatch');
        if (result.backup && (result.backup.path !== s.backupPath || (r.backups[s.slotId] ? result.backup.sha256 !== r.backups[s.slotId]!.hash : result.status !== 'backup-only' || s.dispatchIds.length > 0)))
            throw Error('Backup evidence mismatch');
        if (result.status === 'verified' && (stale || !result.backup || s.dispatchIds.length < 1 || !same(result.afterBinding.target, r.binding.target) || result.afterBinding.uid !== r.binding.uid || result.afterBinding.securitySessionId !== r.binding.securitySessionId || result.afterBinding.helperRevision !== r.binding.helperRevision || result.afterBinding.textUnits !== r.binding.textUnits + r.view.literal.length))
            throw Error('Untrusted verified result');
        if (result.status === 'no-input' && (s.dispatchIds.length || r.backups[s.slotId] || result.backup))
            throw Error('Input evidence contradicts no-input');
        if (result.status === 'backup-only' && (!result.backup || s.dispatchIds.length&&result.noInputSent!==true))
            throw Error('Input evidence contradicts backup-only');
        if (result.backup) s.backupCreated = true;
        s.status = result.status === 'no-input' ? 'skipped' : result.status;
        s.reason = result.status === 'verified' ? undefined : result.reasonCode;
        if (result.status === 'verified')
            r.binding = clone(result.afterBinding);
        if ((result.status==='no-input'||result.status==='backup-only')&&['target-drift','invalid-path','invalid-file','file-drift','binding-drift','native-precondition','policy-blocked','preflight-unavailable'].includes(result.reasonCode??'')&&r.view.authorityStatus==='active'){r.view.authorityStatus='reapproval-required';r.generation++;}
        if (result.status === 'unknown') {
            if (r.view.authorityStatus !== 'revoked')
                r.view.authorityStatus = 'blocked-unknown';
            r.generation++;
        }
        else if (!r.view.remainingSlots && r.view.authorityStatus === 'active' && !r.view.slots.some(s => s.status === 'reserved'))
            r.view.authorityStatus = 'exhausted';
        this.commit();
    }
    revoke(req: {
        automationId: string;
        expectedRevision: number;
    }) { this.ready(); if (req.expectedRevision !== this.data.revision)
        throw Error('Stale recipe revision'); const r = this.data.rows.find(r => r.view.automationId === req.automationId); if (!r)
        throw Error('Unknown recipe'); this.offers.clear(); r.view.authorityStatus = 'revoked'; r.generation++; this.commit(); return this.snapshot(); }
    invalidate(reason: string, nextEpoch: NativeRecipeEpoch) { this.ready(); this.offers.clear(); this.epoch = clone(nextEpoch); for (const r of this.data.rows)
        if (r.view.authorityStatus === 'active') {
            r.view.authorityStatus = 'reapproval-required';
            r.generation++;
            for (const s of r.view.slots)
                if (s.status === 'scheduled')
                    s.reason = reason;
        } this.commit(); }
}
