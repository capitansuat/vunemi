import type { ModelsDecision, ModelsMemoryView, ResidentId } from "../../shared/ipc.js";
import type { MemoryReader } from "./memory.js";

/**
 * One place that decides about memory for Vunemi's local models: the
 * context a chat-model launch gets, and which idle servers go when macOS
 * runs short. Nothing busy is ever stopped: not a running task, not a
 * meeting being recorded. One decision at a time.
 */

/** A model server the manager may measure and stop. */
export interface Resident {
  id: ResidentId;
  /** True while it must not be stopped. */
  busy(): boolean;
  /** The running process, or null when nothing is loaded. */
  pid(): number | null;
  /** Bytes of the model file the process maps: its footprint leaves them out. */
  mapped(): number;
  unload(): Promise<void>;
}

export interface FitRequest {
  wanted: number;
  /** Bytes a launch with this context takes (memory.ts, need). */
  need: (context: number) => number;
  /** The resident this launch replaces: its memory comes back before the new one loads. */
  replacing?: ResidentId;
}

/** Unloaded first when room is needed; the chat model last. */
const ORDER: ResidentId[] = ["meaning", "voice", "chat"];
const HELPERS: ResidentId[] = ["meaning", "voice"];
/** The shortest context the chat model is opened with. */
export const FLOOR_CONTEXT = 8_192;
const WATCH_MS = 15_000;

/** The wanted context, then halves of it, ending at the floor. */
export function candidates(wanted: number): number[] {
  if (wanted <= FLOOR_CONTEXT) return [wanted];
  const out = [wanted];
  for (let c = Math.floor(wanted / 2); c > FLOOR_CONTEXT; c = Math.floor(c / 2)) out.push(c);
  out.push(FLOOR_CONTEXT);
  return out;
}

/** A decision before it is stamped with its time. */
type Decision = { kind: "unloaded"; ids: ResidentId[] } | { kind: "lowered"; context: number; wanted: number };

export class ModelManager {
  private readonly residents = new Map<ResidentId, Resident>();
  private last: ModelsDecision | null = null;
  /** The previous reading was a warning: a second one also takes the idle chat model. */
  private warned = false;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { reader: MemoryReader; totalMemory: number; now?: () => number }) {}

  register(r: Resident): void {
    this.residents.set(r.id, r);
  }

  /** The context the chat model can open with, after the room idle helpers give. */
  fit(req: FitRequest): Promise<{ context: number; tight: boolean }> {
    return this.serial(async () => {
      let free = await this.free(req.replacing);
      if (free === null || req.need(req.wanted) <= free) return { context: req.wanted, tight: false };
      if ((await this.unloadIdle(HELPERS)).length > 0) free = (await this.free(req.replacing)) ?? free;
      for (const context of candidates(req.wanted)) {
        if (req.need(context) > free) continue;
        if (context < req.wanted) this.decide({ kind: "lowered", context, wanted: req.wanted });
        return { context, tight: false };
      }
      // Not even the floor fits: open with it anyway, and let the user know it will be slow.
      const context = Math.min(req.wanted, FLOOR_CONTEXT);
      if (context < req.wanted) this.decide({ kind: "lowered", context, wanted: req.wanted });
      return { context, tight: true };
    });
  }

  /** One reading of macOS's memory pressure. */
  tick(): Promise<void> {
    return this.serial(async () => {
      if (![...this.residents.values()].some((r) => r.pid() !== null)) {
        this.warned = false;
        return;
      }
      const level = await this.opts.reader.pressure();
      if (level === null) return;
      if (level >= 4) await this.unloadIdle(ORDER);
      else if (level >= 2) await this.unloadIdle(this.warned ? ORDER : HELPERS);
      this.warned = level >= 2;
    });
  }

  /** Reads the pressure every 15 seconds; a reading with no model loaded asks macOS nothing. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), WATCH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async view(): Promise<ModelsMemoryView> {
    const residents = await Promise.all(
      ORDER.map(async (id) => {
        const r = this.residents.get(id);
        const pid = r?.pid() ?? null;
        if (!r || pid === null) return { id, loaded: false, bytes: null };
        const own = await this.opts.reader.footprint(pid);
        return { id, loaded: true, bytes: own === null ? null : own + r.mapped() };
      }),
    );
    return { total: this.opts.totalMemory, available: await this.opts.reader.available(), residents, last: this.last };
  }

  private async free(replacing?: ResidentId): Promise<number | null> {
    const available = await this.opts.reader.available();
    if (available === null) return null;
    const r = replacing ? this.residents.get(replacing) : undefined;
    const pid = r?.pid() ?? null;
    if (!r || pid === null) return available;
    return available + ((await this.opts.reader.footprint(pid)) ?? 0) + r.mapped();
  }

  private async unloadIdle(ids: ResidentId[]): Promise<ResidentId[]> {
    const done: ResidentId[] = [];
    for (const id of ids) {
      const r = this.residents.get(id);
      if (!r || r.pid() === null || r.busy()) continue;
      try {
        await r.unload();
        done.push(id);
      } catch (err) {
        console.error(`[vunemi] could not unload ${id}:`, err);
      }
    }
    if (done.length > 0) this.decide({ kind: "unloaded", ids: done });
    return done;
  }

  private decide(d: Decision): void {
    this.last = { ...d, at: (this.opts.now ?? Date.now)() };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
