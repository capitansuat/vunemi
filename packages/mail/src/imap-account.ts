import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { MailNotSent, NO_REPLY_SENDER, type Draft, type MailAccount, type MailAddress, type MessageBody, type MessageSummary, type Moved, type MoveTarget, type SearchQuery } from "./types.js";
import { t } from "@ocak/i18n";

export interface ImapSmtpConfig {
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** SMTP 465 and IMAP 993 use TLS from the first byte. Port 587 uses STARTTLS. */
  smtpSecure: boolean;
  user: string;
}

export function validateMailConfig(value: unknown): ImapSmtpConfig {
  if (!value || typeof value !== "object") throw new Error(t("mail.config.needed"));
  const raw = value as Record<string, unknown>;
  const field = (name: string, max = 255) => {
    const original = String(raw[name] ?? "");
    const text = original.trim();
    if (!text || text.length > max || /[\r\n\0]/.test(original)) throw new Error(t("mail.config.invalidField", { name }));
    return text;
  };
  const port = (name: string) => {
    const n = Number(raw[name]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t("mail.config.invalidField", { name }));
    return n;
  };
  const email = field("email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(t("mail.config.badEmail"));
  const imapHost = field("imapHost");
  const smtpHost = field("smtpHost");
  if (![imapHost, smtpHost].every((host) => /^[a-z0-9.-]+$/i.test(host) && !host.startsWith("-") && !host.endsWith("-"))) {
    throw new Error(t("mail.config.badHost"));
  }
  return {
    email, imapHost, imapPort: port("imapPort"), smtpHost, smtpPort: port("smtpPort"),
    smtpSecure: raw.smtpSecure === true, user: field("user"),
  };
}

/**
 * How the IMAP connection is encrypted. 993 speaks TLS from the first byte;
 * everything else (in practice 143) starts in the clear and must upgrade.
 *
 * The upgrade is required, never opportunistic. ImapFlow's default is to
 * upgrade only when the server advertises STARTTLS, and a man in the middle
 * can strip that line — at which point the password would go out in plain
 * text. So a server that will not upgrade is refused.
 */
/** Sent by a machine or a list rather than a person, going by its headers. */
export function automated(headers: Buffer | undefined): boolean {
  if (!headers) return false;
  const text = headers.toString("utf8");
  return /^(list-unsubscribe|list-id):/im.test(text)
    || /^precedence:\s*(bulk|list|junk)/im.test(text)
    || /^auto-submitted:\s*(?!no\b)\S/im.test(text);
}

/** Where an account's password may be used: its own IMAP and SMTP servers. */
export function mailTargets(config: Pick<ImapSmtpConfig, "imapHost" | "smtpHost">): string[] {
  return [`imap:${config.imapHost}`, `smtp:${config.smtpHost}`];
}

export function imapTls(config: Pick<ImapSmtpConfig, "imapPort">): { secure: boolean; doSTARTTLS: boolean } {
  return config.imapPort === 993 ? { secure: true, doSTARTTLS: false } : { secure: false, doSTARTTLS: true };
}

/** Google's published IMAP/SMTP endpoints; the user only supplies an address. */
export function gmailConfig(email: unknown): ImapSmtpConfig {
  return validateMailConfig({
    email, user: email, imapHost: "imap.gmail.com", imapPort: 993,
    smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true,
  });
}

/** Google displays 16-character app passwords in groups separated by spaces. */
export function gmailAppPassword(value: unknown): string {
  if (typeof value !== "string") throw new Error(t("mail.config.gmailPassword"));
  const password = value.replace(/\s/g, "");
  if (!password) throw new Error(t("mail.config.gmailPassword"));
  return password;
}

interface MessageId { mailbox: string; validity: string; uid: number }

function encodeId(id: MessageId): string {
  return Buffer.from(JSON.stringify(id)).toString("base64url");
}

function decodeId(raw: string): MessageId {
  try {
    const id = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MessageId;
    if (!id || typeof id.mailbox !== "string" || id.mailbox.length > 255 || typeof id.validity !== "string" ||
      !/^\d+$/.test(id.validity) || !Number.isSafeInteger(id.uid) || id.uid < 1) throw new Error();
    return id;
  } catch {
    throw new Error(t("mail.badId"));
  }
}

function address(value: { name?: string; address?: string } | undefined): MailAddress {
  return { address: value?.address ?? "", ...(value?.name ? { name: value.name } : {}) };
}

function summary(message: FetchMessageObject, mailbox: string, validity: string): MessageSummary {
  const envelope = message.envelope;
  return {
    id: encodeId({ mailbox, validity, uid: message.uid }),
    from: address(envelope?.from?.[0]),
    subject: envelope?.subject ?? "(no subject)",
    date: new Date(envelope?.date ?? 0).toISOString(),
    mailbox,
    unread: !message.flags?.has("\\Seen"),
    hasAttachments: Boolean(message.bodyStructure?.childNodes?.some((node) => node.disposition === "attachment")),
    snippet: "",
  };
}

/**
 * How an account signs in to one server: a password, or an OAuth access
 * token (Gmail signed in with Google, XOAUTH2).
 */
export type MailAuth = string | { accessToken: string };

export class ImapSmtpAccount implements MailAccount {
  readonly label: string;

  constructor(
    private readonly config: ImapSmtpConfig,
    /**
     * The password (or access token) for one server, named "imap:<host>" or
     * "smtp:<host>" so the vault can check it.
     */
    private readonly password: (target: string) => MailAuth | Promise<MailAuth>,
    /** Extra trusted certificate authority; only for tests against a local server. */
    private readonly extraCa?: string,
  ) {
    this.label = config.email;
  }

  private async client(): Promise<ImapFlow> {
    const auth = await this.password(`imap:${this.config.imapHost}`);
    return new ImapFlow({
      host: this.config.imapHost, port: this.config.imapPort, ...imapTls(this.config),
      auth: typeof auth === "string" ? { user: this.config.user, pass: auth } : { user: this.config.user, accessToken: auth.accessToken },
      logger: false, disableAutoIdle: true, connectionTimeout: 10_000,
    });
  }

  private async withClient<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      await client.connect();
      return await work(client);
    } finally {
      if (!client.isClosed) await client.logout().catch(() => client.close());
    }
  }

  async ready(): Promise<boolean> {
    try {
      return await this.withClient(async () => true);
    } catch {
      return false;
    }
  }

  async search(query: SearchQuery): Promise<MessageSummary[]> {
    return this.withClient(async (client) => {
      const mailbox = query.mailbox || "INBOX";
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const validity = String(client.mailbox && client.mailbox.uidValidity);
        const criteria = {
          ...(query.text ? { text: query.text } : {}),
          ...(query.from ? { from: query.from } : {}),
          ...(query.unreadOnly ? { seen: false } : {}),
          ...(query.days ? { since: new Date(Date.now() - query.days * 86_400_000) } : {}),
        };
        const ids = await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true });
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const selected = ids.slice(-Math.min(Math.max(query.limit ?? 15, 1), 50));
        const messages = await client.fetchAll(selected, { envelope: true, flags: true, bodyStructure: true }, { uid: true });
        return messages.map((message) => summary(message, mailbox, validity)).sort((a, b) => b.date.localeCompare(a.date));
      } finally {
        lock.release();
      }
    });
  }

  async awaitingReply(days: number, limit: number): Promise<MessageSummary[]> {
    const me = this.config.email.toLowerCase();
    return this.withClient(async (client) => {
      const folders = await client.list();
      const sent = folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? null;
      let candidates: { summary: MessageSummary; messageId?: string }[] = [];
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const validity = String(client.mailbox && client.mailbox.uidValidity);
        const since = new Date(Date.now() - days * 86_400_000);
        const ids = await client.search({ since, answered: false, to: this.config.email }, { uid: true });
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const selected = ids.slice(-Math.min(limit * 3, 100));
        const messages = await client.fetchAll(selected, {
          envelope: true, flags: true, bodyStructure: true,
          headers: ["list-unsubscribe", "list-id", "precedence", "auto-submitted"],
        }, { uid: true });
        for (const message of messages) {
          const from = message.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
          if (!from || from === me || NO_REPLY_SENDER.test(from) || automated(message.headers)) continue;
          const messageId = message.envelope?.messageId;
          candidates.push({ summary: summary(message, "INBOX", validity), ...(messageId && { messageId }) });
        }
      } finally {
        lock.release();
      }
      candidates.sort((a, b) => b.summary.date.localeCompare(a.summary.date));
      candidates = candidates.slice(0, limit * 2);
      // Some clients reply without setting \Answered: a reply in Sent that
      // points at the message counts as an answer too.
      if (sent && candidates.length > 0) {
        const sentLock = await client.getMailboxLock(sent, { readOnly: true });
        try {
          const kept: typeof candidates = [];
          for (const candidate of candidates) {
            if (candidate.messageId) {
              const replies = await client.search({ header: { "in-reply-to": candidate.messageId } }, { uid: true });
              if (Array.isArray(replies) && replies.length > 0) continue;
            }
            kept.push(candidate);
          }
          candidates = kept;
        } finally {
          sentLock.release();
        }
      }
      return candidates.slice(0, limit).map((candidate) => candidate.summary);
    });
  }

  async read(rawId: string): Promise<MessageBody> {
    const id = decodeId(rawId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(id.mailbox, { readOnly: true });
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== id.validity) {
          throw new Error(t("mail.mailboxChanged"));
        }
        const details = await client.fetchOne(String(id.uid), { size: true }, { uid: true });
        if (!details) throw new Error(t("mail.notFound"));
        if ((details.size ?? 0) > 2_000_000) throw new Error(t("mail.tooLarge"));
        const message = await client.fetchOne(String(id.uid), { envelope: true, flags: true, bodyStructure: true, source: true }, { uid: true });
        if (!message || !message.source) throw new Error(t("mail.notFound"));
        if (message.source.length > 2_000_000) throw new Error(t("mail.tooLarge"));
        const parsed = await simpleParser(message.source);
        const base = summary(message, id.mailbox, id.validity);
        const list = (item: typeof parsed.to) => (Array.isArray(item) ? item : item ? [item] : []).flatMap((part) => part.value.map(address));
        return {
          ...base,
          to: list(parsed.to), cc: list(parsed.cc),
          text: parsed.text ?? "[No plain-text content.]",
          attachments: parsed.attachments.map((item) => ({ name: item.filename ?? "(unnamed attachment)", bytes: item.size })),
        };
      } finally {
        lock.release();
      }
    });
  }

  private async mailer() {
    const auth = await this.password(`smtp:${this.config.smtpHost}`);
    return nodemailer.createTransport({
      host: this.config.smtpHost, port: this.config.smtpPort, secure: this.config.smtpSecure,
      requireTLS: !this.config.smtpSecure,
      auth: typeof auth === "string"
        ? { user: this.config.user, pass: auth }
        : { type: "OAuth2", user: this.config.user, accessToken: auth.accessToken },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
      ...(this.extraCa && { tls: { ca: this.extraCa } }),
    });
  }

  private async replyMessageId(rawId: string): Promise<string> {
    const id = decodeId(rawId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(id.mailbox, { readOnly: true });
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== id.validity) {
          throw new Error(t("mail.mailboxChanged"));
        }
        const message = await client.fetchOne(String(id.uid), { envelope: true }, { uid: true });
        const messageId = message && message.envelope?.messageId;
        if (!messageId) throw new Error(t("mail.noMessageId"));
        return messageId;
      } finally {
        lock.release();
      }
    });
  }

  private async message(draft: Draft) {
    return {
      from: this.config.email, to: draft.to, ...(draft.cc ? { cc: draft.cc } : {}),
      subject: draft.subject, text: draft.body,
      ...(draft.inReplyTo ? { inReplyTo: await this.replyMessageId(draft.inReplyTo) } : {}),
    };
  }

  async saveDraft(draft: Draft): Promise<{ id: string }> {
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await composer.sendMail(await this.message(draft));
    const bytes = info.message;
    if (!Buffer.isBuffer(bytes)) throw new Error(t("mail.draftFailed"));
    return this.withClient(async (client) => {
      const folders = await client.list();
      const drafts = folders.find((folder) => folder.specialUse === "\\Drafts")?.path;
      if (!drafts) throw new Error(t("mail.noDrafts"));
      const result = await client.append(drafts, bytes, ["\\Draft"]);
      if (!result) throw new Error(t("mail.draftFailed"));
      // UIDPLUS is optional. Without both values, deletion could target a
      // different message after a mailbox reset, so no undo is offered.
      const uid = result.uid;
      const id = typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0 && result.uidValidity
        ? encodeId({ mailbox: drafts, validity: String(result.uidValidity), uid })
        : "";
      return { id };
    });
  }

  async deleteDraft(rawId: string): Promise<void> {
    const id = decodeId(rawId);
    return this.withClient(async (client) => {
      // The Drafts folder is found the way saveDraft found it: the opened
      // mailbox often doesn't carry its special-use flag, so checking that
      // would refuse every undo.
      const folders = await client.list();
      const drafts = folders.find((folder) => folder.specialUse === "\\Drafts")?.path;
      if (drafts !== id.mailbox) throw new Error(t("mail.mailboxChanged"));
      const lock = await client.getMailboxLock(id.mailbox);
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== id.validity) throw new Error(t("mail.mailboxChanged"));
        const message = await client.fetchOne(String(id.uid), { flags: true }, { uid: true });
        if (!message || !message.flags?.has("\\Draft")) throw new Error(t("mail.notFound"));
        if (!await client.messageDelete(String(id.uid), { uid: true })) throw new Error(t("mail.notFound"));
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Where a move goes: the folder the server marks as Trash or Archive (for
   * Gmail, All Mail is its archive), or a folder the user named. Never a
   * guess: a name that matches nothing, or more than one, is refused.
   */
  private async destination(client: ImapFlow, to: MoveTarget): Promise<string> {
    const folders = (await client.list()).filter((f) => !f.flags?.has("\\Noselect"));
    if (to.kind === "trash") {
      const trash = folders.find((f) => f.specialUse === "\\Trash")?.path;
      if (!trash) throw new Error(t("mail.noTrash"));
      return trash;
    }
    if (to.kind === "archive") {
      const archive = folders.find((f) => f.specialUse === "\\Archive")?.path ?? folders.find((f) => f.specialUse === "\\All")?.path;
      if (!archive) throw new Error(t("mail.noArchive"));
      return archive;
    }
    const wanted = to.name.trim().toLowerCase();
    const exact = folders.filter((f) => f.path.toLowerCase() === wanted);
    const byName = exact.length ? exact : folders.filter((f) => f.name.toLowerCase() === wanted);
    if (byName.length === 1) return byName[0]!.path;
    throw new Error(t("mail.noSuchFolder", { name: to.name.slice(0, 80), names: folders.map((f) => f.path).join(", ").slice(0, 600) }));
  }

  /** Moves one message by id, and finds it again where it landed. */
  private async moveOne(client: ImapFlow, id: MessageId, destination: string): Promise<string> {
    if (destination === id.mailbox) throw new Error(t("mail.sameFolder", { mailbox: destination }));
    const lock = await client.getMailboxLock(id.mailbox);
    let moved: Awaited<ReturnType<ImapFlow["messageMove"]>>;
    let messageId: string | undefined;
    try {
      if (!client.mailbox || String(client.mailbox.uidValidity) !== id.validity) throw new Error(t("mail.mailboxChanged"));
      const message = await client.fetchOne(String(id.uid), { envelope: true }, { uid: true });
      if (!message) throw new Error(t("mail.notFound"));
      messageId = message.envelope?.messageId;
      moved = await client.messageMove(String(id.uid), destination, { uid: true });
      if (!moved) throw new Error(t("mail.moveFailed"));
    } finally {
      lock.release();
    }
    const uid = moved.uidMap?.get(id.uid);
    if (uid && moved.uidValidity) return encodeId({ mailbox: destination, validity: String(moved.uidValidity), uid });
    // Without UIDPLUS the server doesn't say; the Message-ID finds it instead.
    if (!messageId) return "";
    const there = await client.getMailboxLock(destination, { readOnly: true });
    try {
      const validity = String(client.mailbox && client.mailbox.uidValidity);
      const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
      const last = Array.isArray(found) && found.length > 0 ? Math.max(...found) : 0;
      return last > 0 ? encodeId({ mailbox: destination, validity, uid: last }) : "";
    } finally {
      there.release();
    }
  }

  async move(rawId: string, to: MoveTarget): Promise<Moved> {
    const id = decodeId(rawId);
    return this.withClient(async (client) => {
      const destination = await this.destination(client, to);
      return { id: await this.moveOne(client, id, destination), from: id.mailbox, to: destination };
    });
  }

  async moveBack(rawId: string, from: string): Promise<void> {
    const id = decodeId(rawId);
    await this.withClient(async (client) => {
      if (!(await client.list()).some((f) => f.path === from)) throw new Error(t("mail.noSuchFolder", { name: from, names: "—" }));
      await this.moveOne(client, id, from);
    });
  }

  async setRead(rawId: string, read: boolean): Promise<boolean> {
    const id = decodeId(rawId);
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(id.mailbox);
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== id.validity) throw new Error(t("mail.mailboxChanged"));
        const message = await client.fetchOne(String(id.uid), { flags: true }, { uid: true });
        if (!message) throw new Error(t("mail.notFound"));
        const was = message.flags?.has("\\Seen") === true;
        if (was !== read) {
          const done = read
            ? await client.messageFlagsAdd(String(id.uid), ["\\Seen"], { uid: true })
            : await client.messageFlagsRemove(String(id.uid), ["\\Seen"], { uid: true });
          if (!done) throw new Error(t("mail.notFound"));
        }
        return was;
      } finally {
        lock.release();
      }
    });
  }

  async send(draft: Draft): Promise<void> {
    let transport: Awaited<ReturnType<ImapSmtpAccount["mailer"]>>;
    try {
      transport = await this.mailer();
    } catch (err) {
      // No password or token to sign in with: nothing went anywhere.
      throw new MailNotSent(err instanceof Error ? err.message : String(err));
    }
    try {
      // Connect, encrypt and sign in without a message first: any failure
      // here certainly sent nothing, whatever nodemailer calls the error.
      try {
        await transport.verify();
      } catch (err) {
        throw new MailNotSent(err instanceof Error ? err.message : String(err));
      }
      let info: { accepted?: unknown[]; rejected?: unknown[] };
      try {
        info = await transport.sendMail(await this.message(draft));
      } catch (err) {
        if (neverAccepted(err)) throw new MailNotSent(err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (info.rejected?.length) {
        // Nodemailer resolves when even one recipient was accepted. The
        // outbox must not call that a complete send or retry it automatically.
        throw new Error(t("mail.partialDelivery", {
          accepted: info.accepted?.join(", ") || "—",
          rejected: info.rejected.join(", "),
        }));
      }
    } finally {
      transport.close();
    }
  }

  async verify(): Promise<void> {
    await this.withClient(async () => undefined);
    const transport = await this.mailer();
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
}

/**
 * Whether an SMTP failure happened before the server took the message: the
 * connection, TLS, sign-in or envelope was refused, or the server answered
 * the finished message with a refusal. A dropped connection mid-message is
 * not one of these; nobody can say whether it arrived.
 */
export function neverAccepted(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, command, responseCode, syscall, message } = err as {
    code?: string; command?: string; responseCode?: number; syscall?: string; message?: string;
  };
  if (code === "EAUTH" || code === "ETLS" || code === "EENVELOPE" || code === "EREQUIRETLS" || code === "EDNS") return true;
  // Nodemailer labels every socket failure "CONN", even one in the middle of
  // the message, so only failures that can only happen while connecting count:
  // the TCP connect itself, its timeout, or a server that never greeted.
  if (code === "ESOCKET" && syscall === "connect") return true;
  if (code === "ETIMEDOUT" && (message === "Connection timeout" || message === "Greeting never received")) return true;
  // The server read the message and said no.
  if (code === "EMESSAGE" && command === "DATA" && typeof responseCode === "number" && responseCode >= 400) return true;
  return false;
}
