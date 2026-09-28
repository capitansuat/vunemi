/**
 * Mailboxes the Mac's Mail app already has, reached over Apple Events.
 *
 * No password comes near Vunemi: Mail signs in, and its scripting won't
 * even hand an account's password out. Every script is a fixed template
 * that takes the picked account's name and touches only that account; what
 * the model asked for travels as the single JSON argument. Special mailboxes
 * are found through Mail's own top-level inbox and trash, whose children
 * name their account, never by guessing what a server calls them.
 */

import { AppScriptError, type ScriptRunner } from "@vunemi/apps";
import { MailNotSent, NO_REPLY_SENDER, type Draft, type MailAccount, type MessageBody, type MessageSummary, type Moved, type MoveTarget, type SearchQuery } from "@vunemi/mail";
import { t } from "@vunemi/i18n";

const APP = "Mail";
/** Messages whose text a free-text search also reads; Mail's body search is slow. */
const BODY_SCAN = 150;
const SNIPPET = 160;
const LONG_MS = 60_000;
const SHORT_MS = 30_000;
const DENIED = -1743;

/** Path markers for the account's own inbox and trash; printable, since scripts travel as argv. */
const INBOX = "\u2400inbox";
const TRASH = "\u2400trash";

const HELPERS = `
function acct(app, name) {
  var list = app.accounts.whose({ name: name })();
  if (list.length === 0) throw new Error("NO_ACCOUNT");
  return list[0];
}
function special(top, name) {
  var kids = top.mailboxes();
  for (var i = 0; i < kids.length; i++) { try { if (kids[i].account().name() === name) return kids[i]; } catch (_) {} }
  throw new Error("NO_MAILBOX");
}
function boxes(acc) {
  var out = [];
  function walk(list, path) {
    for (var i = 0; i < list.length; i++) {
      var p = path.concat([list[i].name()]);
      out.push({ box: list[i], path: p });
      try { walk(list[i].mailboxes(), p); } catch (_) {}
    }
  }
  walk(acc.mailboxes(), []);
  return out;
}
function boxAt(app, acc, name, path) {
  if (path.length === 1 && path[0] === "${INBOX}") return special(app.inbox, name);
  if (path.length === 1 && path[0] === "${TRASH}") return special(app.trashMailbox, name);
  var all = boxes(acc);
  for (var i = 0; i < all.length; i++) if (JSON.stringify(all[i].path) === JSON.stringify(path)) return all[i].box;
  throw new Error("NO_MAILBOX");
}
function who(s) {
  var m = /^(.*?)\\s*<([^>]+)>\\s*$/.exec(String(s || ""));
  return m ? { name: m[1].replace(/^"|"$/g, ""), address: m[2] } : { address: String(s || "") };
}
function summary(msg, path, snippet) {
  var d = msg.dateReceived();
  var text = "";
  if (snippet > 0) { try { text = String(msg.content()).replace(/\\s+/g, " ").slice(0, snippet); } catch (_) {} }
  var atts = 0;
  try { atts = msg.mailAttachments().length; } catch (_) {}
  return { id: msg.id(), path: path, from: who(msg.sender()), subject: msg.subject() || "", date: d ? d.toISOString() : "", unread: !msg.readStatus(), hasAttachments: atts > 0, snippet: text };
}
function newestFirst(spec, limit) {
  var ids = spec.id(), dates = spec.dateReceived(), order = [];
  for (var i = 0; i < ids.length; i++) order.push({ id: ids[i], at: dates[i] ? dates[i].getTime() : 0 });
  order.sort(function (x, y) { return y.at - x.at; });
  return order.slice(0, limit).map(function (o) { return o.id; });
}
function fatal(e) { return e.errorNumber === -1743 || e.errorNumber === -1712 || e.errorNumber === -600; }
`;

function script(marker: string, body: string): string {
  return `// ${marker}\n${HELPERS}\nfunction run(argv) {\n  var a = JSON.parse(argv[0]);\n  var app = Application("com.apple.mail");\n${body}\n}`;
}

export const MAIL_ACCOUNTS = script("MAIL_ACCOUNTS", `
  var list = app.accounts(), out = [];
  for (var i = 0; i < list.length; i++) {
    try { out.push({ name: list[i].name(), emails: list[i].emailAddresses(), enabled: list[i].enabled() }); } catch (e) { if (fatal(e)) throw e; }
  }
  return JSON.stringify({ accounts: out });`);

export const MAIL_READY = script("MAIL_READY", `
  var list = app.accounts.whose({ name: a.account })();
  return JSON.stringify({ ready: list.length > 0 && list[0].enabled() });`);

export const MAIL_SEARCH = script("MAIL_SEARCH", `
  var acc = acct(app, a.account);
  var box = boxAt(app, acc, a.account, a.path);
  var and = [];
  if (a.days) and.push({ dateReceived: { _greaterThan: new Date(Date.now() - a.days * 86400000) } });
  if (a.unreadOnly) and.push({ readStatus: false });
  if (a.from) and.push({ sender: { _contains: a.from } });
  var base = and.length ? box.messages.whose(and.length === 1 ? and[0] : { _and: and }) : box.messages;
  var ids = [];
  if (a.text) {
    var hit = base.whose({ _or: [{ subject: { _contains: a.text } }, { sender: { _contains: a.text } }] });
    ids = newestFirst(hit, a.limit);
    if (ids.length < a.limit) {
      var needle = String(a.text).toLowerCase();
      var recent = newestFirst(base, a.scan);
      for (var i = 0; i < recent.length && ids.length < a.limit; i++) {
        if (ids.indexOf(recent[i]) !== -1) continue;
        try { if (String(box.messages.byId(recent[i]).content()).toLowerCase().indexOf(needle) !== -1) ids.push(recent[i]); } catch (e) { if (fatal(e)) throw e; }
      }
    }
  } else {
    ids = newestFirst(base, a.limit);
  }
  var out = [];
  for (var j = 0; j < ids.length; j++) out.push(summary(box.messages.byId(ids[j]), a.path, a.snippet));
  return JSON.stringify({ messages: out });`);

export const MAIL_READ = script("MAIL_READ", `
  var acc = acct(app, a.account);
  var msg = boxAt(app, acc, a.account, a.path).messages.byId(a.id);
  var out = summary(msg, a.path, 0);
  function people(list) { var r = []; for (var i = 0; i < list.length; i++) r.push({ name: list[i].name() || undefined, address: list[i].address() }); return r; }
  out.to = people(msg.toRecipients());
  out.cc = people(msg.ccRecipients());
  out.text = String(msg.content() || "");
  var atts = msg.mailAttachments(), files = [];
  for (var i = 0; i < atts.length; i++) { var size = 0; try { size = atts[i].fileSize(); } catch (_) {} files.push({ name: atts[i].name(), bytes: size }); }
  out.attachments = files;
  return JSON.stringify(out);`);

export const MAIL_AWAITING = script("MAIL_AWAITING", `
  var acc = acct(app, a.account);
  var box = special(app.inbox, a.account);
  var spec = box.messages.whose({ _and: [{ dateReceived: { _greaterThan: new Date(Date.now() - a.days * 86400000) } }, { wasRepliedTo: false }] });
  var ids = newestFirst(spec, a.limit), out = [];
  for (var i = 0; i < ids.length; i++) out.push(summary(box.messages.byId(ids[i]), ["${INBOX}"], a.snippet));
  return JSON.stringify({ messages: out });`);

// Says which step failed, as Messages does: before "send" nothing left; at "send" it is unknown.
export const MAIL_COMPOSE = script("MAIL_COMPOSE", `
  var step = "compose", msg;
  try {
    var acc = acct(app, a.account);
    if (a.reply) {
      msg = boxAt(app, acc, a.account, a.reply.path).messages.byId(a.reply.id).reply({ openingWindow: false, replyToAll: false });
      msg.content = a.body;
    } else {
      msg = app.OutgoingMessage({ visible: false, subject: a.subject, content: a.body });
      app.outgoingMessages.push(msg);
    }
    msg.subject = a.subject;
    msg.sender = a.from;
    var have = [];
    try { var now = msg.toRecipients(); for (var i = 0; i < now.length; i++) have.push(String(now[i].address()).toLowerCase()); } catch (_) {}
    for (var j = 0; j < a.to.length; j++) if (have.indexOf(a.to[j].toLowerCase()) === -1) msg.toRecipients.push(app.ToRecipient({ address: a.to[j] }));
    for (var k = 0; k < a.cc.length; k++) msg.ccRecipients.push(app.CcRecipient({ address: a.cc[k] }));
    if (a.mode === "draft") {
      msg.save();
      return JSON.stringify({ saved: true, id: msg.id() });
    }
    step = "send";
    return JSON.stringify({ handedOver: msg.send() === true });
  } catch (e) {
    if (fatal(e)) throw e;
    return JSON.stringify({ failed: step, reason: String(e.message || e) });
  }`);

export const MAIL_MOVE = script("MAIL_MOVE", `
  var acc = acct(app, a.account);
  var msg = boxAt(app, acc, a.account, a.path).messages.byId(a.id);
  var target, path;
  if (a.to.kind === "trash") { target = special(app.trashMailbox, a.account); path = ["${TRASH}"]; }
  else if (a.to.kind === "archive") {
    var all = boxes(acc), names = [["Archive"], ["Archives"], ["[Gmail]", "All Mail"], ["[Google Mail]", "All Mail"]];
    for (var n = 0; n < names.length && !target; n++) for (var i = 0; i < all.length; i++) if (JSON.stringify(all[i].path) === JSON.stringify(names[n])) { target = all[i].box; path = all[i].path; break; }
    if (!target) return JSON.stringify({ refused: "NO_ARCHIVE" });
  } else { target = boxAt(app, acc, a.account, a.to.path); path = a.to.path; }
  var rfc = msg.messageId();
  app.move(msg, { to: target });
  var id = 0;
  for (var tries = 0; tries < 5 && !id; tries++) {
    var found = target.messages.whose({ messageId: rfc })();
    if (found.length) id = found[0].id(); else delay(0.4);
  }
  return JSON.stringify({ id: id, path: path, to: target.name() });`);

export const MAIL_MARK = script("MAIL_MARK", `
  var acc = acct(app, a.account);
  var msg = boxAt(app, acc, a.account, a.path).messages.byId(a.id);
  var was = msg.readStatus();
  msg.readStatus = a.read;
  return JSON.stringify({ wasRead: was });`);

/** A message as Vunemi names it: its mailbox path and Mail's id, in one opaque string. */
export function messageRef(path: string[], id: number): string {
  return JSON.stringify([path, id]);
}

export function parseRef(ref: string): { path: string[]; id: number } {
  let value: unknown;
  try {
    value = JSON.parse(ref);
  } catch {
    throw new Error("Not a Mail message id; search again.");
  }
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[0]) || !value[0].every((p) => typeof p === "string") || !Number.isInteger(value[1])) {
    throw new Error("Not a Mail message id; search again.");
  }
  return { path: value[0] as string[], id: value[1] as number };
}

/** The mailbox as the model is told it, and back. */
function boxName(path: string[]): string {
  if (path.length === 1 && path[0] === INBOX) return "Inbox";
  if (path.length === 1 && path[0] === TRASH) return "Trash";
  return path.join("/");
}

function boxPath(name: string | undefined): string[] {
  const trimmed = (name ?? "").trim();
  if (!trimmed || /^inbox$/i.test(trimmed)) return [INBOX];
  if (/^trash$/i.test(trimmed)) return [TRASH];
  return trimmed.split("/").map((part) => part.trim()).filter(Boolean);
}

interface Found {
  id: number;
  path: string[];
  from: { name?: string; address: string };
  subject: string;
  date: string;
  unread: boolean;
  hasAttachments: boolean;
  snippet: string;
}

function toSummary(found: Found): MessageSummary {
  return {
    id: messageRef(found.path, found.id),
    from: found.from,
    subject: found.subject,
    date: found.date,
    mailbox: boxName(found.path),
    unread: found.unread,
    hasAttachments: found.hasAttachments,
    snippet: found.snippet,
  };
}

/** The enabled accounts Mail has, for the user to choose from. */
export async function listMailAppAccounts(run: ScriptRunner): Promise<{ name: string; emails: string[] }[]> {
  const result = (await run(MAIL_ACCOUNTS, { app: APP }, { timeoutMs: SHORT_MS })) as { accounts: { name: string; emails: string[]; enabled: boolean }[] };
  return result.accounts.filter((a) => a.enabled).map((a) => ({ name: a.name, emails: a.emails }));
}

export class AppleMailAccount implements MailAccount {
  readonly label: string;
  /** Mail does the sending; Vunemi can confirm only the hand-over. */
  readonly handedTo = APP;

  constructor(private readonly run: ScriptRunner, private readonly entry: { account: string; email: string }) {
    this.label = entry.email;
  }

  private async call<T>(template: string, input: Record<string, unknown>, timeoutMs = SHORT_MS): Promise<T> {
    try {
      return (await this.run(template, { app: APP, account: this.entry.account, ...input }, { timeoutMs })) as T;
    } catch (err) {
      // Removed or renamed in Mail since it was connected.
      if (err instanceof Error && err.message.includes("NO_ACCOUNT")) throw new Error(t("connectors.mail.appleMailUnknown", { name: this.entry.account }));
      throw err;
    }
  }

  async ready(): Promise<boolean> {
    try {
      return (await this.call<{ ready: boolean }>(MAIL_READY, {})).ready;
    } catch (err) {
      // A refused permission is the user's to fix, and the connection says where.
      if (err instanceof AppScriptError && err.code === DENIED) throw err;
      return false;
    }
  }

  async search(query: SearchQuery): Promise<MessageSummary[]> {
    const limit = Math.max(1, Math.min(50, query.limit ?? 15));
    const { messages } = await this.call<{ messages: Found[] }>(MAIL_SEARCH, {
      path: boxPath(query.mailbox),
      ...(query.text && { text: query.text }),
      ...(query.from && { from: query.from }),
      ...(query.unreadOnly && { unreadOnly: true }),
      ...(query.days && { days: query.days }),
      limit,
      scan: BODY_SCAN,
      snippet: SNIPPET,
    }, LONG_MS);
    return messages.map(toSummary);
  }

  async read(id: string): Promise<MessageBody> {
    const { path, id: messageId } = parseRef(id);
    const found = await this.call<Found & { to: MessageBody["to"]; cc: MessageBody["cc"]; text: string; attachments: MessageBody["attachments"] }>(MAIL_READ, { path, id: messageId });
    return { ...toSummary(found), to: found.to, cc: found.cc, text: found.text, attachments: found.attachments };
  }

  async awaitingReply(days: number, limit: number): Promise<MessageSummary[]> {
    const { messages } = await this.call<{ messages: Found[] }>(MAIL_AWAITING, { days, limit: limit * 3, snippet: SNIPPET }, LONG_MS);
    const own = this.entry.email.toLowerCase();
    return messages
      .filter((m) => !NO_REPLY_SENDER.test(m.from.address) && m.from.address.toLowerCase() !== own)
      .slice(0, limit)
      .map(toSummary);
  }

  private compose(mode: "draft" | "send", draft: Draft): Record<string, unknown> {
    return {
      mode,
      from: this.entry.email,
      to: draft.to,
      cc: draft.cc ?? [],
      subject: draft.subject,
      body: draft.body,
      ...(draft.inReplyTo && { reply: parseRef(draft.inReplyTo) }),
    };
  }

  async saveDraft(draft: Draft): Promise<{ id: string }> {
    const result = await this.call<{ saved?: boolean; id?: number; failed?: string; reason?: string }>(MAIL_COMPOSE, this.compose("draft", draft));
    if (!result.saved) throw new Error(t("apps.error.failed", { app: APP, detail: result.reason ?? "" }));
    // Mail's draft id doesn't survive the save as a message id, so there is no undo to offer.
    return { id: "" };
  }

  async send(draft: Draft): Promise<void> {
    // A script that didn't answer at all rejects as it is: whether Mail took it can't be told.
    const result = await this.call<{ handedOver?: boolean; failed?: string; reason?: string }>(MAIL_COMPOSE, this.compose("send", draft));
    if (result.failed && result.failed !== "send") throw new MailNotSent(result.reason ?? "Mail refused the message.");
    if (result.failed) throw new Error(`Mail may or may not have sent it: ${result.reason ?? "no answer"}.`);
    if (result.handedOver !== true) throw new MailNotSent("Mail did not take the message.");
  }

  async move(id: string, to: MoveTarget): Promise<Moved> {
    const { path, id: messageId } = parseRef(id);
    const target = to.kind === "folder" ? { kind: "path", path: boxPath(to.name) } : to;
    const result = await this.call<{ id?: number; path?: string[]; to?: string; refused?: string }>(MAIL_MOVE, { path, id: messageId, to: target });
    if (result.refused === "NO_ARCHIVE") throw new Error(t("mail.appleMail.noArchive", { label: this.label }));
    return { id: result.id && result.path ? messageRef(result.path, result.id) : "", from: JSON.stringify(path), to: result.to ?? boxName(result.path ?? []) };
  }

  async moveBack(id: string, from: string): Promise<void> {
    const { path, id: messageId } = parseRef(id);
    const back = JSON.parse(from) as string[];
    await this.call(MAIL_MOVE, { path, id: messageId, to: { kind: "path", path: back } });
  }

  async setRead(id: string, read: boolean): Promise<boolean> {
    const { path, id: messageId } = parseRef(id);
    return (await this.call<{ wasRead: boolean }>(MAIL_MARK, { path, id: messageId, read })).wasRead;
  }
}
