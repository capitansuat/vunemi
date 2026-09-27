/**
 * The app lock: an optional door in front of Vunemi's window. Off unless the
 * user turns it on.
 *
 * It is a door, not a safe. The vault is encrypted whether the lock is on or
 * off; what the lock decides is whether the window answers — whether someone
 * at an unlocked Mac can read the sessions, see the mail, or start a run.
 * macOS does the asking (Touch ID, a watch, or the login password, in its
 * own dialog), so Vunemi never handles the password.
 *
 * Enforced here, in main, not in the window: while locked, the IPC guard in
 * index.ts refuses every channel but the few a locked screen needs. Stopping
 * a run is one of them. A lock must never stand between the user and the
 * emergency stop.
 */

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "failed" | "unavailable" | "timeout" | "error"; detail?: string };

/**
 * Asks the Mac's owner to prove it. `reason` is the line macOS shows; an
 * abort takes the dialog down, because the Mac locked while it was open.
 */
export type Authenticate = (reason: string, signal: AbortSignal) => Promise<AuthResult>;

/** The dialog on screen, and the lock it was raised to open. */
interface Asking {
  answer: Promise<AuthResult>;
  generation: number;
  abort: AbortController;
}

export class AppLock {
  private locked: boolean;
  private pending: Asking | null = null;
  private lockGeneration = 0;
  private readonly listeners = new Set<(locked: boolean) => void>();

  constructor(
    private readonly enabled: () => boolean,
    private readonly authenticate: Authenticate,
  ) {
    this.locked = enabled();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Locks, if the user asked for a lock at all. Called when the Mac locks. */
  lock(): void {
    if (!this.enabled()) return;
    // A Mac lock invalidates an authentication already in progress, even if
    // Vunemi was still locked when the system event arrived.
    this.lockGeneration++;
    // An answer to that dialog would open this lock without anyone having
    // been asked for it: take it down.
    this.pending?.abort.abort();
    if (this.locked) return;
    this.locked = true;
    this.emit();
  }

  async unlock(reason: string): Promise<AuthResult> {
    if (!this.locked) return { ok: true };
    const { result, generation } = await this.ask(reason);
    if (generation !== this.lockGeneration) return { ok: false, reason: "cancelled" };
    if (result.ok && this.locked) {
      this.locked = false;
      this.emit();
    }
    return result;
  }

  /**
   * Turning the lock on or off asks first, both ways: on, so nobody locks
   * themselves out with a Mac that can't answer; off, so whoever turns it off
   * is the owner and not just whoever found the window open.
   */
  async setEnabled(on: boolean, reason: string, save: (on: boolean) => void): Promise<AuthResult> {
    if (on === this.enabled()) return { ok: true };
    const { result, generation } = await this.ask(reason);
    if (generation !== this.lockGeneration) return { ok: false, reason: "cancelled" };
    if (result.ok) save(on);
    return result;
  }

  onChange(fn: (locked: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * One system dialog at a time: a second click waits for the first. The
   * answer carries the lock it was asked under, so a dialog raised before the
   * Mac locked can't open the lock that came after; a click then waits for
   * that old dialog to go and asks again.
   */
  private async ask(reason: string): Promise<{ result: AuthResult; generation: number }> {
    while (this.pending && this.pending.generation !== this.lockGeneration) await this.pending.answer;
    if (!this.pending) {
      const abort = new AbortController();
      const answer: Promise<AuthResult> = this.authenticate(reason, abort.signal)
        .catch((err): AuthResult => ({ ok: false, reason: "error", detail: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          if (this.pending?.answer === answer) this.pending = null;
        });
      this.pending = { answer, generation: this.lockGeneration, abort };
    }
    const { answer, generation } = this.pending;
    return { result: await answer, generation };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.locked);
  }
}
