/**
 * A mailbox whose connection lives in the Vault process. Every call carries
 * the account's description, so a Vault process that restarted picks the
 * account up again without being told; the password never comes here.
 */
import type { Draft, MailAccount, MessageBody, MessageSummary, Moved, MoveTarget, SearchQuery } from "@ocak/mail";
import type { VaultClient } from "@ocak/vault";
import { mailAddressOf, type StoredMailAccount } from "./settings.js";

/** Long enough for a slow SMTP server; the mail library has its own, shorter, timeouts. */
const MAIL_CALL_TIMEOUT_MS = 5 * 60_000;

export class RemoteMailAccount implements MailAccount {
  readonly label: string;

  constructor(private readonly vault: VaultClient, private readonly entry: StoredMailAccount) {
    this.label = mailAddressOf(entry);
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.vault.call<T>("mail.call", [this.entry, method, args], MAIL_CALL_TIMEOUT_MS);
  }

  async ready(): Promise<boolean> {
    if (!this.vault.has(`mail.${this.entry.id}`)) return false;
    try {
      return await this.call<boolean>("ready");
    } catch {
      return false;
    }
  }

  search(query: SearchQuery): Promise<MessageSummary[]> {
    return this.call("search", query);
  }

  read(id: string): Promise<MessageBody> {
    return this.call("read", id);
  }

  saveDraft(draft: Draft): Promise<{ id: string }> {
    return this.call("saveDraft", draft);
  }

  async deleteDraft(id: string): Promise<void> {
    await this.call("deleteDraft", id);
  }

  /** A refusal before the server took the message arrives marked notSent; the outbox reads the mark. */
  async send(draft: Draft): Promise<void> {
    await this.call("send", draft);
  }

  awaitingReply(days: number, limit: number): Promise<MessageSummary[]> {
    return this.call("awaitingReply", days, limit);
  }

  // Every transport the Vault process opens (IMAP and Graph) can move and
  // mark; left off here, the organise tools said "can't be done" for all mail.
  move(id: string, to: MoveTarget): Promise<Moved> {
    return this.call("move", id, to);
  }

  async moveBack(id: string, from: string): Promise<void> {
    await this.call("moveBack", id, from);
  }

  setRead(id: string, read: boolean): Promise<boolean> {
    return this.call("setRead", id, read);
  }
}
