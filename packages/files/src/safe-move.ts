/** Semantic file move, never GUI drag. Requires fd-relative atomic no-clobber adapter.
 * Source identity revalidation is NOT a kernel source-version compare-and-swap. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { Roots } from './roots.js';
export type MoveIdentity = Readonly<{
    device: string;
    inode: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    sha256: string;
}>;
export type DirectoryIdentity = Readonly<{
    path: string;
    device: string;
    inode: string;
    uid: number;
    mode: number;
}>;
export type SafeMovePlan = Readonly<{
    operationId: string;
    ownerId: string;
    source: string;
    destination: string;
    sourceIdentity: MoveIdentity;
    sourceParents: readonly DirectoryIdentity[];
    destinationParents: readonly DirectoryIdentity[];
}>;
export type AtomicMoveRequest = SafeMovePlan & {
    signal?: AbortSignal;
    assertActive?: () => void;
};
export type AtomicMoveResult = {
    status: 'moved';
} | {
    status: 'not-moved';
    reasonCode: string;
} | {
    status: 'unknown';
    reasonCode: string;
};
/** MUST use same-volume fd-relative rename with atomic destination exclusion,
 * never exists+rename or an overwrite-capable rename. */
export interface AtomicMoveAdapter {
    move(request: AtomicMoveRequest): Promise<AtomicMoveResult>;
}
export type SafeMoveContext = {
    /** Trusted caller backup/setup, executed only within the current writer admission. */
    beforeEffect?: () => void;
    ownerId: string;
    signal?: AbortSignal;
    assertActive?: () => void;
};
export type SafeMoveReceipt = Readonly<{
    operationId: string;
    status: 'verified';
    source: string;
    destination: string;
    sourceAbsent: true;
    destinationHash: string;
    destinationIdentity: MoveIdentity;
}>;
type State = 'prepared' | 'dispatched' | 'verified' | 'unknown' | 'refused';
type Row = {
    operationId: string;
    ownerId: string;
    source: string;
    destination: string;
    sourceDevice: string;
    sourceInode: string;
    state: State;
    updatedAt: number;
    sourceSize?: string;
    sourceHash?: string;
};
export class SafeMoveError extends Error {
    readonly noInputSent: boolean;
    readonly deliveryUnknown: boolean;
    constructor(readonly reasonCode: string, readonly operationId?: string, unknown = false) { super(`File move ${unknown ? 'outcome unknown' : 'refused'}: ${reasonCode}${operationId ? ` (${operationId})` : ''}`); this.name = 'SafeMoveError'; this.noInputSent = !unknown; this.deliveryUnknown = unknown; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, MAX = 128, LIMIT = 256 * 1024 * 1024;
function no(code: string, id?: string): never { throw new SafeMoveError(code, id); }
function present(p: string) { try {
    lstatSync(p);
    return true;
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return false;
    throw e;
} }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function owner(s: string) { return typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\u0000-\u001f]/.test(s); }
function identity(p: string): MoveIdentity { const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try {
    const a = fstatSync(fd, { bigint: true });
    if (!a.isFile() || a.size > BigInt(LIMIT))
        no('source-not-bounded-regular-file');
    const h = createHash('sha256'), buf = Buffer.alloc(65536);
    let n = 0, total = 0;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
        total += n;
        if (total > LIMIT)
            no('source-too-large');
        h.update(buf.subarray(0, n));
    }
    const b = fstatSync(fd, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs || BigInt(total) !== b.size)
        no('source-changed');
    return Object.freeze({ device: String(b.dev), inode: String(b.ino), size: String(b.size), mtimeNs: String(b.mtimeNs), ctimeNs: String(b.ctimeNs), sha256: h.digest('hex') });
}
finally {
    closeSync(fd);
} }
function parents(p: string): readonly DirectoryIdentity[] { const out: DirectoryIdentity[] = []; for (let at = dirname(p);;) {
    const s = lstatSync(at, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink())
        no('parent-not-real-directory');
    out.push(Object.freeze({ path: at, device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), mode: Number(s.mode) }));
    const next = dirname(at);
    if (next === at)
        break;
    at = next;
} return Object.freeze(out.reverse()); }
/** One instance per userData journal. run is called only from approved trusted ToolDef
 * closure; plans are in-memory unforgeable objects and cannot be restored/replayed. */
export class SafeMoveController {
    private plans = new WeakSet<object>();
    private consumed = new WeakSet<object>();
    private rows: Row[] = [];
    private busy = false;
    constructor(private options: {
        roots: Roots;
        journalPath: string;
        adapter?: AtomicMoveAdapter;
        withAdmission?: <T>(body: (assertCurrent: () => void) => Promise<T> | T, signal?: AbortSignal) => Promise<T>;
    }) { this.rows = this.load(); }

    /** Queries and constructors never recover another live writer's intent. */
    private load(): Row[] {
        let fd: number | undefined;
        try {
            const path = this.options.journalPath;
            if (!isAbsolute(path)) no('journal-unavailable');
            parents(path);
            if (!present(path)) return [];
            fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.size > 262144n) no('journal-unavailable');
            const data = JSON.parse(readFileSync(fd, 'utf8')) as { version?: unknown; rows?: unknown };
            const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
            if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) no('journal-unavailable');
            if (!data || Object.keys(data).sort().join(',') !== 'rows,version' || data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > MAX) no('journal-unavailable');
            const ids = new Set<string>();
            return data.rows.map(value => {
                const r = value as Row;
                if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['operationId','ownerId','source','destination','sourceDevice','sourceInode','state','updatedAt','sourceSize','sourceHash'].includes(k)) || typeof r.operationId !== 'string' || !UUID.test(r.operationId) || ids.has(r.operationId) || !owner(r.ownerId) || typeof r.source !== 'string' || typeof r.destination !== 'string' || !isAbsolute(r.source) || !isAbsolute(r.destination) || typeof r.sourceDevice !== 'string' || typeof r.sourceInode !== 'string' || !/^\d+$/.test(r.sourceDevice) || !/^\d+$/.test(r.sourceInode) || !['prepared','dispatched','verified','unknown','refused'].includes(r.state) || !Number.isFinite(r.updatedAt) || r.updatedAt < 0 || (r.sourceSize !== undefined || r.sourceHash !== undefined) && (typeof r.sourceSize !== 'string' || !/^\d+$/.test(r.sourceSize) || typeof r.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceHash))) no('journal-unavailable');
                ids.add(r.operationId);
                return { ...r };
            });
        } catch { return no('journal-unavailable'); }
        finally { if (fd !== undefined) closeSync(fd); }
    }
    private persist(assertCurrent: () => void): void {
        const p = this.options.journalPath, temp = join(dirname(p), `.safe-move-${randomUUID()}.tmp`);
        let fd: number | undefined;
        try {
            assertCurrent();
            fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            assertCurrent(); writeFileSync(fd, JSON.stringify({ version: 1, rows: this.rows }));
            assertCurrent(); fsyncSync(fd);
            closeSync(fd); fd = undefined;
            assertCurrent(); renameSync(temp, p);
            const dir = openSync(dirname(p), constants.O_RDONLY | constants.O_NOFOLLOW);
            try { assertCurrent(); fsyncSync(dir); } finally { closeSync(dir); }
        } finally {
            if (fd !== undefined) closeSync(fd);
            if (existsSync(temp)) { try { assertCurrent(); unlinkSync(temp); } catch { /* Lost ownership cannot perform journal cleanup. */ } }
        }
    }
    private update(id: string, state: State, assertCurrent: () => void): void {
        assertCurrent();
        const row = this.rows.find(r => r.operationId === id);
        if (!row) no('journal-unavailable', id);
        row.state = state; row.updatedAt = Date.now(); this.persist(assertCurrent);
    }
    private active(c: SafeMoveContext, id?: string): void {
        if (c.signal?.aborted) no('stopped', id);
        try { c.assertActive?.(); } catch { no('stopped', id); }
    }
    private blocked(source: string, destination: string, src: MoveIdentity): boolean {
        return this.rows.some(r => ['unknown','prepared','dispatched'].includes(r.state) && (r.source === source || r.source === destination || r.destination === source || r.destination === destination || r.sourceDevice === src.device && r.sourceInode === src.inode));
    }
    prepare(a: { source: string; destination: string; ownerId: string }): SafeMovePlan {
        if (!owner(a.ownerId)) no('invalid-owner');
        if (this.busy) no('move-busy');
        let source: string, destination: string, src: MoveIdentity, sp: readonly DirectoryIdentity[], dp: readonly DirectoryIdentity[];
        try {
            if (lstatSync(a.source).isSymbolicLink()) no('source-symlink');
            source = this.options.roots.resolve(a.source, 'write');
            destination = this.options.roots.resolve(a.destination, 'write');
            if (source === destination) no('same-path');
            if (present(destination)) no('destination-exists');
            src = identity(source); sp = parents(source); dp = parents(destination);
            if (src.device !== dp.at(-1)?.device) no('cross-volume-unsupported');
        } catch (e) { if (e instanceof SafeMoveError) throw e; no('path-unavailable'); }
        this.rows = this.load();
        if (this.blocked(source, destination, src)) no('unknown-operation-blocks-target');
        const plan = Object.freeze({ operationId: randomUUID(), ownerId: a.ownerId, source, destination, sourceIdentity: src, sourceParents: sp, destinationParents: dp });
        this.plans.add(plan);
        return plan;
    }
    check(p: SafeMovePlan, c: SafeMoveContext): SafeMovePlan { return this.checkCurrent(p, c, false); }
    private checkCurrent(p: SafeMovePlan, c: SafeMoveContext, admitted: boolean): SafeMovePlan {
        if (!this.plans.has(p)) no('invalid-receipt');
        if (!admitted && this.consumed.has(p)) no('receipt-consumed', p.operationId);
        if (c.ownerId !== p.ownerId || !owner(c.ownerId)) no('owner-mismatch', p.operationId);
        this.active(c, p.operationId);
        try {
            if (this.options.roots.resolve(p.source, 'write') !== p.source || this.options.roots.resolve(p.destination, 'write') !== p.destination) no('path-changed', p.operationId);
            if (!same(parents(p.source), p.sourceParents) || !same(parents(p.destination), p.destinationParents)) no('parent-changed', p.operationId);
            if (!same(identity(p.source), p.sourceIdentity)) no('source-changed', p.operationId);
            if (present(p.destination)) no('destination-exists', p.operationId);
        } catch (e) { if (e instanceof SafeMoveError) throw e; no('path-changed', p.operationId); }
        this.active(c, p.operationId);
        return p;
    }
    async run(p: SafeMovePlan, c: SafeMoveContext): Promise<SafeMoveReceipt> {
        if (this.busy) no('move-busy', p.operationId);
        this.check(p, c);
        if (!this.options.withAdmission) no('journal-unavailable', p.operationId);
        if (!this.options.adapter) no('adapter-unavailable', p.operationId);
        const adapter = this.options.adapter;
        this.busy = true;
        let attempted = false;
        try {
            return await this.options.withAdmission(async assertCurrent => {
                let intent = false, confirmedRefusal = false;
                const guard = () => { assertCurrent(); this.active(c, p.operationId); };
                try {
                    guard();
                    this.rows = this.load();
                    let abandoned = false;
                    for (const r of this.rows) if (r.state === 'prepared' || r.state === 'dispatched') { r.state = 'unknown'; r.updatedAt = Date.now(); abandoned = true; }
                    if (abandoned) this.persist(assertCurrent);
                    this.check(p, c);
                    if (this.blocked(p.source, p.destination, p.sourceIdentity)) no('unknown-operation-blocks-target', p.operationId);
                    if (this.rows.some(row => row.operationId === p.operationId)) no('invalid-receipt', p.operationId);
                    while (this.rows.length >= MAX) {
                        const index = this.rows.findIndex(row => row.state === 'verified' || row.state === 'refused');
                        if (index < 0) no('journal-capacity', p.operationId);
                        this.rows.splice(index, 1);
                    }
                    guard(); this.consumed.add(p);
                    this.rows.push({ operationId: p.operationId, ownerId: p.ownerId, source: p.source, destination: p.destination, sourceDevice: p.sourceIdentity.device, sourceInode: p.sourceIdentity.inode, sourceSize: p.sourceIdentity.size, sourceHash: p.sourceIdentity.sha256, state: 'prepared', updatedAt: Date.now() });
                    intent = true; this.persist(assertCurrent);
                    guard(); this.checkCurrent(p, c, true);
                    guard(); c.beforeEffect?.(); guard(); this.checkCurrent(p, c, true);
                    this.update(p.operationId, 'dispatched', assertCurrent);
                    guard(); attempted = true;
                    const result = await adapter.move(Object.freeze({ ...p, ...(c.signal ? { signal: c.signal } : {}), assertActive: guard }));
                    assertCurrent();
                    if (result.status === 'not-moved') {
                        this.update(p.operationId, 'refused', assertCurrent); confirmedRefusal = true;
                        no(typeof result.reasonCode === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(result.reasonCode) ? result.reasonCode : 'adapter-refused', p.operationId);
                    }
                    if (result.status !== 'moved') throw new SafeMoveError('adapter-outcome-unknown', p.operationId, true);
                    guard();
                    if (!same(parents(p.source), p.sourceParents) || !same(parents(p.destination), p.destinationParents) || present(p.source)) throw new SafeMoveError('independent-verification-failed', p.operationId, true);
                    const destination = identity(p.destination);
                    if (destination.device !== p.sourceIdentity.device || destination.inode !== p.sourceIdentity.inode || destination.sha256 !== p.sourceIdentity.sha256 || destination.size !== p.sourceIdentity.size) throw new SafeMoveError('independent-verification-failed', p.operationId, true);
                    guard(); this.update(p.operationId, 'verified', assertCurrent);
                    return Object.freeze({ operationId: p.operationId, status: 'verified', source: p.source, destination: p.destination, sourceAbsent: true, destinationHash: destination.sha256, destinationIdentity: destination });
                } catch (e) {
                    if (intent && !confirmedRefusal) { try { this.update(p.operationId, attempted ? 'unknown' : 'refused', assertCurrent); } catch { /* Durable intent remains quarantined by the next admitted writer. */ } }
                    if (attempted && !confirmedRefusal) throw new SafeMoveError(e instanceof SafeMoveError ? e.reasonCode : 'adapter-outcome-unknown', p.operationId, true);
                    if (e instanceof SafeMoveError) throw e;
                    no('journal-unavailable', p.operationId);
                }
            }, c.signal);
        } catch (e) {
            if (e instanceof SafeMoveError) throw e;
            if (attempted) throw new SafeMoveError('adapter-outcome-unknown', p.operationId, true);
            no(c.signal?.aborted ? 'stopped' : 'journal-unavailable', p.operationId);
        } finally { this.busy = false; }
    }
    query(id: string): Readonly<Row> | null {
        if (!UUID.test(id)) no('invalid-operation-id');
        const row = this.load().find(value => value.operationId === id);
        return row ? Object.freeze({ ...row }) : null;
    }
}
