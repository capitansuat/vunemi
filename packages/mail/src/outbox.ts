/**
 * Nothing leaves immediately.
 *
 * An approval card is answered in a second, often while the user is reading
 * something else; the realisation that the mail was wrong arrives ten seconds
 * later. Gmail's undo-send exists for exactly that gap, and an agent that
 * drafts the words itself needs it more than a human typist does.
 *
 * So `mail_send` does not send. It puts the message here, the user gets a
 * window in which one click takes it back, and only when the window closes
 * does the transport see it. This is the one place in the app where "undo"
 * is the literal truth rather than a compensating action.
 *
 * The queue is written before a send is accepted. An interrupted SMTP call
 * is never retried automatically: its outcome might have reached the server.
 */

import { randomUUID } from "node:crypto";
import { MailNotSent, type Draft, type MailAccount } from "./types.js";
import { t } from "@ocak/i18n";

/** Long enough to catch a mistake, short enough not to feel broken. */
export const HOLD_MS = 45_000;

export interface Pending {
  id: string;
  draft: Draft;
  /** Which mailbox it will leave from. */
  account: string;
  /** When it goes, unless taken back first. */
  at: number;
}

export interface StoredSend extends Pending {
  accountId: string;
  state: "held" | "sending" | "uncertain";
}

/**
 * Where the queue lives between launches. Either sync or async: the outbox
 * waits for every write before it acts on it.
 */
export interface OutboxStorage {
  load(): StoredSend[] | Promise<StoredSend[]>;
  save(messages: StoredSend[]): void | Promise<void>;
}

export interface UncertainSend {
  id: string;
  account: string;
  subject: string;
}

export type OutboxEvent =
  | { kind: "held"; message: Pending }
  | { kind: "sending"; id: string }
  | { kind: "sent"; id: string }
  | { kind: "cancelled"; id: string }
  | { kind: "dismissed"; id: string }
  | { kind: "failed"; id: string; error: string };

/** How many taken-back messages the outbox remembers for a late undo. */
const MAX_REMEMBERED_CANCELS = 200;

export class Outbox {
  private readonly held = new Map<
    string,
    { pending: Pending; account: MailAccount; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(event: OutboxEvent) => void>();
  private readonly sending = new Map<string, Promise<void>>();
  private readonly sendingAccounts = new Map<string, string>();
  private stored: StoredSend[] = [];
  private restored = false;
  private restoring: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Taken back this session, so a second "take back" can say it already was. */
  /** Recently taken-back ids, oldest first. */
  private readonly cancelled = new Set<string>();

  // One outbox for every mailbox: the countdown belongs to the app, and the
  // user should see one list of what is about to go, not one per account.
  constructor(private readonly holdMs: number = HOLD_MS, private readonly storage?: OutboxStorage) {}

  /** Restore only after account credentials have been loaded. */
  restore(resolve: (accountId: string) => MailAccount | undefined): Promise<void> {
    this.restoring ??= this.load(resolve).finally(() => { this.restoring = null; });
    return this.restoring;
  }

  private async load(resolve: (accountId: string) => MailAccount | undefined): Promise<void> {
    if (this.restored) return;
    const records = (await this.storage?.load()) ?? [];
    if (!Array.isArray(records) || !records.every(validStoredSend) || new Set(records.map((item) => item.id)).size !== records.length) {
      throw new Error(t("mail.outbox.invalid"));
    }
    const next = records.map((record) => ({ ...record }));
    const ready: { pending: StoredSend; account: MailAccount }[] = [];
    const errors: { id: string; error: string }[] = [];
    let changed = false;
    for (const record of next) {
      if (record.state !== "held") {
        if (record.state === "sending") { record.state = "uncertain"; changed = true; }
        errors.push({ id: record.id, error: t("mail.outbox.unknownAfterRestart") });
        continue;
      }
      const account = resolve(record.accountId);
      if (!account) {
        record.state = "uncertain";
        changed = true;
        errors.push({ id: record.id, error: t("mail.outbox.accountGone", { account: record.account }) });
        continue;
      }
      // Give the user a fresh chance to cancel an overdue send after launch.
      if (record.at <= Date.now()) { record.at = Date.now() + this.holdMs; changed = true; }
      ready.push({ pending: record, account });
    }
    if (changed) await this.storage?.save(next);
    this.stored = next;
    this.restored = true;
    for (const { pending, account } of ready) {
      this.schedule(pending, account);
      this.emit({ kind: "held", message: pending });
    }
    for (const { id, error } of errors) this.emit({ kind: "failed", id, error });
  }

  on(listener: (event: OutboxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get pending(): Pending[] {
    return [...this.held.values()].map((h) => h.pending);
  }

  get uncertain(): UncertainSend[] {
    return this.stored.filter((item) => item.state === "uncertain").map((item) => ({
      id: item.id, account: item.account, subject: item.draft.subject,
    }));
  }

  get busy(): boolean {
    return this.held.size > 0 || this.sending.size > 0;
  }

  hasWorkFor(account: string): boolean {
    return this.pending.some((item) => item.account === account) ||
      [...this.sendingAccounts.values()].includes(account);
  }

  /** Accepts a message once it is written down, and starts its clock. Returns what to tell the user. */
  async hold(from: { id: string; label: string; account: MailAccount }, draft: Draft): Promise<Pending> {
    if (this.storage && !this.restored) throw new Error(t("mail.outbox.notLoaded"));
    const pending: StoredSend = { id: `m-${randomUUID()}`, draft, account: from.label, accountId: from.id, at: Date.now() + this.holdMs, state: "held" };
    await this.persist((stored) => [...stored, pending]);
    this.schedule(pending, from.account);
    this.emit({ kind: "held", message: pending });
    return pending;
  }

  /**
   * Takes a message back. True if it was still in time. Its clock stops
   * first, so it can't go while the removal is written; if the write fails
   * it is held again, with the same deadline, and the error says why.
   */
  async cancel(id: string): Promise<boolean> {
    const entry = this.held.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.held.delete(id);
    try {
      await this.persist((stored) => stored.filter((item) => item.id !== id));
    } catch (err) {
      this.schedule(entry.pending as StoredSend, entry.account);
      throw err;
    }
    this.cancelled.add(id);
    // Only for answering a late undo truthfully; the oldest are long past
    // anyone clicking it, and the set shouldn't grow with the session.
    if (this.cancelled.size > MAX_REMEMBERED_CANCELS) this.cancelled.delete(this.cancelled.values().next().value!);
    this.emit({ kind: "cancelled", id });
    return true;
  }

  /** Whether this message was taken back (from the outbox or by an undo). */
  wasCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /** Removes an acknowledged unknown outcome; this cannot undo an SMTP send. */
  async dismiss(id: string): Promise<boolean> {
    if (!this.stored.some((item) => item.id === id && item.state === "uncertain")) return false;
    await this.persist((stored) => stored.filter((item) => item.id !== id));
    this.emit({ kind: "dismissed", id });
    return true;
  }

  /** Waits for sends already in flight; held messages keep their deadline. */
  async settle(): Promise<void> {
    // A held message can cross its deadline while another SMTP call is still
    // running. Wait for every send that starts before shutdown completes.
    while (this.sending.size > 0) await Promise.all([...this.sending.values()]);
  }

  private schedule(pending: StoredSend, account: MailAccount): void {
    const timer = setTimeout(() => void this.release(pending.id), Math.max(0, pending.at - Date.now()));
    timer.unref?.();
    this.held.set(pending.id, { pending, account, timer });
  }

  private release(id: string): Promise<void> {
    const entry = this.held.get(id);
    if (!entry) return Promise.resolve();
    // From here it is going: a take-back now is too late, and says so.
    clearTimeout(entry.timer);
    this.held.delete(id);
    this.sendingAccounts.set(id, entry.pending.account);
    const job = (async () => {
      try {
        const record = this.stored.find((item) => item.id === id);
        if (record) {
          try {
            await this.persist((stored) => stored.map((item) => item.id === id ? { ...item, state: "sending" as const } : item));
          } catch (err) {
            // Not marked as going, so not sent: held again for another round.
            this.emit({ kind: "failed", id, error: t("mail.outbox.writeFailed", { reason: err instanceof Error ? err.message : String(err) }) });
            this.schedule({ ...record, at: Date.now() + this.holdMs }, entry.account);
            return;
          }
        }
        this.emit({ kind: "sending", id });
        let sent = false;
        try {
          await Promise.resolve().then(() => entry.account.send(entry.pending.draft));
          sent = true;
          await this.persist((stored) => stored.filter((item) => item.id !== id));
          this.emit({ kind: "sent", id });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // Refused before the server took it: nothing left, so it can be sent again.
          if (!sent && (err instanceof MailNotSent || (err as { notSent?: unknown })?.notSent === true)) {
            try {
              await this.persist((stored) => stored.filter((item) => item.id !== id));
              this.emit({ kind: "failed", id, error: t("mail.outbox.notSent", { reason }) });
              return;
            } catch {
              // The record couldn't be cleared; fall through and keep it as unknown.
            }
          }
          // Other SMTP errors do not reliably tell us whether the server accepted it.
          try {
            await this.persist((stored) => stored.map((item) => item.id === id ? { ...item, state: "uncertain" as const } : item));
          } catch { /* Keep the durable sending marker. */ }
          this.emit({ kind: "failed", id, error: t(sent ? "mail.outbox.unknownRecord" : "mail.outbox.unknownSmtp", { reason }) });
        }
      } finally {
        this.sending.delete(id);
        this.sendingAccounts.delete(id);
      }
    })();
    this.sending.set(id, job);
    return job;
  }

  /**
   * Every change to the queue goes through here, one at a time, each worked
   * out from the queue as the previous write left it. The in-memory copy
   * changes only once the write succeeded.
   */
  private persist(change: (stored: StoredSend[]) => StoredSend[]): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(this.stored);
      await this.storage?.save(next);
      this.stored = next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private emit(event: OutboxEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function validStoredSend(value: unknown): value is StoredSend {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredSend>;
  const draft = item.draft;
  return typeof item.id === "string" && typeof item.accountId === "string" && typeof item.account === "string" &&
    typeof item.at === "number" && Number.isFinite(item.at) &&
    (item.state === "held" || item.state === "sending" || item.state === "uncertain") &&
    !!draft && Array.isArray(draft.to) && draft.to.every((address) => typeof address === "string") &&
    typeof draft.subject === "string" && typeof draft.body === "string";
}
