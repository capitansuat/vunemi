/**
 * The seam between the mail tools and wherever the mail actually lives.
 *
 * Everything above this line — the filter, the outbox, the tools — is the
 * same whether the messages come from macOS Mail over Apple Events, from
 * IMAP, or from a provider's API behind OAuth. Only the implementations of
 * this interface differ, and they are the only place a credential can exist.
 *
 * Deliberately small. A wide mail API is a wide attack surface, and every
 * verb here is one the user could name out loud.
 */

export interface MailAddress {
  name?: string;
  address: string;
}

/** A message as a list shows it: enough to choose one, not to act on it. */
export interface MessageSummary {
  id: string;
  from: MailAddress;
  subject: string;
  /** ISO 8601. */
  date: string;
  mailbox: string;
  unread: boolean;
  hasAttachments: boolean;
  /** First line or so, already filtered. */
  snippet: string;
}

/** A message opened. `text` has been through the filter. */
export interface MessageBody extends MessageSummary {
  to: MailAddress[];
  cc: MailAddress[];
  text: string;
  attachments: { name: string; bytes: number }[];
}

export interface Draft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Set when this is a reply, so the thread stays a thread. */
  inReplyTo?: string;
}

export interface SearchQuery {
  /** Free text, matched against sender, subject and body. */
  text?: string;
  from?: string;
  mailbox?: string;
  unreadOnly?: boolean;
  /** Only messages newer than this many days. */
  days?: number;
  limit?: number;
}

/**
 * Where a message can be moved: the account's Trash or Archive, or one of
 * its folders by name. There is no deleting for good.
 */
export type MoveTarget = { kind: "trash" } | { kind: "archive" } | { kind: "folder"; name: string };

/**
 * A move, as it can be taken back: the message's id in its new place (empty
 * when the server can't say, and then there is no undo), and where it came
 * from, in a form only this transport reads back.
 */
export interface Moved {
  id: string;
  from: string;
  /** The folder it went to, in the user's words. */
  to: string;
}

/**
 * What a transport has to provide. Note what is missing: no permanent
 * delete. Moving a message and marking it read are here, optional, because
 * each can be put back exactly as it was; the tools ask for every one.
 */
export interface MailAccount {
  /** How to name this account to the user, e.g. "Gmail (test@…)". */
  readonly label: string;
  /** False when the account is not connected yet; tools then say so. */
  ready(): Promise<boolean>;
  search(query: SearchQuery): Promise<MessageSummary[]>;
  read(id: string): Promise<MessageBody>;
  /** Puts a draft in the user's drafts folder. Sends nothing. */
  saveDraft(draft: Draft): Promise<{ id: string }>;
  /** Removes only a draft this account just created. Optional when the server cannot identify it safely. */
  deleteDraft?(id: string): Promise<void>;
  /** Actually sends. Only ever called by the outbox, after its hold expires. */
  send(draft: Draft): Promise<void>;
  /**
   * Messages in the inbox from the last `days` days, written to the user by a
   * person, that the server doesn't mark as answered. Newest first. Optional:
   * a transport that can't tell leaves it out.
   */
  awaitingReply?(days: number, limit: number): Promise<MessageSummary[]>;
  /** Moves one message; never deletes it. */
  move?(id: string, to: MoveTarget): Promise<Moved>;
  /** Puts a moved message back where `from` says it was. */
  moveBack?(id: string, from: string): Promise<void>;
  /** Marks one message read or unread; resolves with whether it was read before. */
  setRead?(id: string, read: boolean): Promise<boolean>;
}

/** Senders no one replies to: machines, lists, notifications. */
export const NO_REPLY_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|bounces?)([._+-]|@)/i;

/**
 * A send that certainly never reached the server: it failed before the
 * message body was accepted (no connection, TLS or sign-in refused, every
 * recipient refused, the server turned the message down). Nothing left the
 * Mac, so the user can safely send it again. Any other failure is treated as
 * an unknown outcome.
 */
export class MailNotSent extends Error {
  readonly notSent = true;
  constructor(message: string) {
    super(message);
    this.name = "MailNotSent";
  }
}
