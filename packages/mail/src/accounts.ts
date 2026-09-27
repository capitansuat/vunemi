/**
 * Several mailboxes, one set of tools.
 *
 * A person has a personal address and a work one, and both have to be
 * reachable at once. The obvious implementation — register the mail tools
 * again per account — is the wrong one: ten near-identical tools would bury
 * a small model, and choosing between `mail_search_gmail` and
 * `mail_search_work` is exactly the kind of decision those models get wrong.
 *
 * So the tools stay singular and the account is a value. Better still, a
 * message id carries its account, so reading and replying never have to ask:
 * only composing something new needs to say which mailbox it is from, and
 * only when there is more than one.
 */

import type { MailAccount } from "./types.js";
import { t } from "@vunemi/i18n";

export interface MailAccountEntry {
  id: string;
  label: string;
  account: MailAccount;
}

/** Separates the account from the message id. Not legal in either part. */
const SEP = "::";

export class MailAccounts {
  private readonly entries = new Map<string, MailAccountEntry>();
  /** Short names handed out for messages, both ways; see handle(). */
  private readonly handles = new Map<string, string>();
  private readonly byHandle = new Map<string, string>();

  add(entry: MailAccountEntry): void {
    this.entries.set(entry.id, entry);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  list(): { id: string; label: string }[] {
    return [...this.entries.values()].map(({ id, label }) => ({ id, label }));
  }

  all(): MailAccountEntry[] {
    return [...this.entries.values()];
  }

  /**
   * The account to act as. With one mailbox the argument is unnecessary;
   * with several, leaving it out is an ambiguity worth refusing rather than
   * guessing — sending from the wrong address is not a small mistake.
   */
  pick(id?: string): MailAccountEntry {
    if (this.entries.size === 0) throw new Error(t("mail.noAccounts"));

    if (id) {
      const byId = this.entries.get(id);
      if (byId) return byId;
      const byLabel = [...this.entries.values()].find((e) => e.label.toLowerCase() === id.toLowerCase());
      if (byLabel) return byLabel;
      throw new Error(t("mail.noSuchAccount", { id, names: this.names() }));
    }

    const only = [...this.entries.values()][0];
    if (this.entries.size === 1 && only) return only;
    throw new Error(t("mail.whichAccount", { names: this.names() }));
  }

  /** Splits an id the search handed out back into account and message. */
  resolve(givenId: string): { entry: MailAccountEntry; messageId: string } {
    const qualifiedId = this.byHandle.get(givenId.trim()) ?? givenId;
    const at = qualifiedId.indexOf(SEP);
    if (at === -1) {
      // An id from before there were several, or one the model invented.
      return { entry: this.pick(), messageId: qualifiedId };
    }
    const entry = this.pick(qualifiedId.slice(0, at));
    return { entry, messageId: qualifiedId.slice(at + SEP.length) };
  }

  /**
   * The id a message is shown to the model by: "m3", not the account and a
   * hundred characters of base64. Gemma 4 E2B copied the long form only up
   * to its "::" and every call after it failed. Handles last as long as the
   * app runs; an old one after a restart resolves to nothing and the tool
   * says to search again.
   */
  handle(accountId: string, messageId: string): string {
    const qualified = MailAccounts.qualify(accountId, messageId);
    let handle = this.handles.get(qualified);
    if (!handle) {
      handle = `m${this.handles.size + 1}`;
      this.handles.set(qualified, handle);
      this.byHandle.set(handle, qualified);
    }
    return handle;
  }

  /** How a message id is shown, so that reading it needs no other context. */
  static qualify(accountId: string, messageId: string): string {
    return `${accountId}${SEP}${messageId}`;
  }

  private names(): string {
    return [...this.entries.values()].map((e) => e.label).join(", ");
  }
}
