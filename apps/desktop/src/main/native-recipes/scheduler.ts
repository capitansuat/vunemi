import type { NativeRecipesSnapshot } from '../../shared/native-recipes';
import type { NativeRecipeClaim } from './types';
import { NativeRecipeStore } from './store';
export interface NativeRecipeSchedulerOptions {
    store: NativeRecipeStore;
    now?: () => number;
    canStart: () => boolean;
    run: (claim: NativeRecipeClaim) => Promise<void>;
    onChanged?: (s: NativeRecipesSnapshot) => void;
}
/** Finite mutation lane: every observed due slot is consumed, including busy/missed slots. */
export class NativeRecipeScheduler {
    private running = false;
    constructor(private options: NativeRecipeSchedulerOptions) { }
    tick(): void {
        const { store } = this.options, now = (this.options.now ?? Date.now)();
        if (!Number.isFinite(now))
            return;
        const previousRevision = store.snapshot().revision;
        store.expire(now);
        if (store.snapshot().revision !== previousRevision) this.changed();
        for (const recipe of store.snapshot().recipes) {
            if (recipe.authorityStatus !== 'active')
                continue;
            for (const slot of recipe.slots) {
                if (slot.status !== 'scheduled' || slot.at > now)
                    continue;
                let claim: NativeRecipeClaim;
                try {
                    claim = store.claim(recipe.automationId, recipe.revision, slot.slotId, now);
                }
                catch {
                    continue;
                }
                let available = false;
                try {
                    available = !this.running && this.options.canStart();
                }
                catch { /* Unverifiable admission consumes this slot. */ }
                if (now - slot.at > 60000 || !available) {
                    store.skip(claim, now - slot.at > 60000 ? 'missed' : 'busy');
                    this.changed();
                    continue;
                }
                this.running = true;
                this.changed();
                // The scheduler holds this slot until the process facade settles its reservation or refusal.
                let work: Promise<void>;
                try {
                    work = this.options.run(claim);
                }
                catch {
                    this.failed(recipe.automationId, slot.slotId, claim);
                    this.running = false;
                    continue;
                }
                void Promise.resolve(work).then(() => this.failed(recipe.automationId, slot.slotId, claim)).catch(() => this.failed(recipe.automationId, slot.slotId, claim)).finally(() => { this.running = false; this.changed(); });
            }
        }
    }
    private changed() { try {
        this.options.onChanged?.(this.options.store.snapshot());
    }
    catch { /* Projection listeners are not admission authority. */ } }
    private failed(id: string, slotId: string, claim: NativeRecipeClaim) { const slot = this.options.store.snapshot().recipes.find(r => r.automationId === id)?.slots.find(s => s.slotId === slotId); if (slot?.status !== 'reserved')
        return; try {
        this.options.store.complete(claim, { status: 'unknown', dispatchIds: slot.dispatchIds, reasonCode: 'runner-unsettled' });
    }
    catch { /* Poisoned persistence retains unresolved parent for restart; no replay. */ } }
}
