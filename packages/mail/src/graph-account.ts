/** Outlook mail via Microsoft Graph, with delegated tokens from the desktop process. */
import { MailNotSent, NO_REPLY_SENDER, type Draft, type MailAccount, type MailAddress, type MessageBody, type MessageSummary, type Moved, type MoveTarget, type SearchQuery } from "./types.js";
import { t } from "@vunemi/i18n";

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  parentFolderId?: string;
  singleValueExtendedProperties?: { id: string; value: string }[];
}

/**
 * PidTagLastVerbExecuted: what was last done to a message. 102 is Reply and
 * 103 Reply All; Outlook, OWA and Outlook for Mac all set it.
 */
const LAST_VERB = "Integer 0x1081";
const REPLIED = new Set(["102", "103"]);

const BASE = "https://graph.microsoft.com/v1.0";

function address(value?: GraphAddress): MailAddress {
  return { address: value?.emailAddress?.address ?? "", ...(value?.emailAddress?.name ? { name: value.emailAddress.name } : {}) };
}

function summary(message: GraphMessage): MessageSummary {
  return {
    id: message.id,
    from: address(message.from),
    subject: message.subject ?? "(no subject)",
    date: message.receivedDateTime ?? new Date(0).toISOString(),
    mailbox: "Outlook",
    unread: message.isRead === false,
    hasAttachments: message.hasAttachments === true,
    snippet: message.bodyPreview ?? "",
  };
}

function recipients(list: string[]) {
  return list.map((value) => ({ emailAddress: { address: value } }));
}

function message(draft: Draft) {
  return {
    subject: draft.subject,
    body: { contentType: "Text", content: draft.body },
    toRecipients: recipients(draft.to),
    ...(draft.cc && { ccRecipients: recipients(draft.cc) }),
  };
}

export class GraphMailAccount implements MailAccount {
  constructor(readonly label: string, private readonly token: () => Promise<string>) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token: string;
    try {
      token = await this.token();
    } catch (err) {
      // Nothing was asked of the server yet.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { beforeRequest: true });
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
        Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error(t("mail.outlook.requestFailed", { status: response.status })), { status: response.status });
    if (response.status === 202 || response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error(t("mail.tooLarge"));
    return JSON.parse(text) as T;
  }

  async ready(): Promise<boolean> {
    try { await this.request("GET", "/me?$select=id"); return true; }
    catch { return false; }
  }

  async awaitingReply(days: number, limit: number): Promise<MessageSummary[]> {
    const me = this.label.toLowerCase();
    const since = new Date(Date.now() - days * 86_400_000);
    const params = new URLSearchParams({
      "$top": String(Math.min(100, limit * 3)),
      "$select": "id,from,toRecipients,subject,receivedDateTime,isRead,hasAttachments,bodyPreview",
      "$filter": `receivedDateTime ge ${since.toISOString()}`,
      "$orderby": "receivedDateTime desc",
      "$expand": `singleValueExtendedProperties($filter=id eq '${LAST_VERB}')`,
    });
    const result = await this.request<{ value: GraphMessage[] }>("GET", `/me/mailFolders/inbox/messages?${params}`);
    return (result.value ?? [])
      .filter((m) => {
        const from = m.from?.emailAddress?.address?.toLowerCase() ?? "";
        const toMe = (m.toRecipients ?? []).some((r) => r.emailAddress?.address?.toLowerCase() === me);
        const verb = m.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === LAST_VERB.toLowerCase())?.value;
        return from && from !== me && toMe && !NO_REPLY_SENDER.test(from) && !(verb && REPLIED.has(verb));
      })
      .slice(0, limit)
      .map(summary);
  }

  async search(query: SearchQuery): Promise<MessageSummary[]> {
    if (query.mailbox && !/^inbox$/i.test(query.mailbox)) {
      throw new Error(t("mail.outlook.inboxOnly"));
    }
    if ((query.text || query.from) && (query.unreadOnly || query.days)) {
      throw new Error(t("mail.outlook.searchCombo"));
    }
    const params = new URLSearchParams({ "$top": String(Math.min(50, Math.max(1, query.limit ?? 15))), "$select": "id,from,subject,receivedDateTime,isRead,hasAttachments,bodyPreview" });
    if (query.text || query.from) {
      const escape = (value: string) => value.replace(/["\\]/g, "\\$&");
      const clauses = [
        query.from && `"from:${escape(query.from)}"`,
        query.text && `"${escape(query.text)}"`,
      ].filter(Boolean);
      params.set("$search", clauses.join(" AND "));
    } else {
      // Graph refuses a $filter that does not lead with the $orderby
      // property ("InefficientFilter"), so the date always comes first. With
      // no date asked for, a floor that excludes nothing stands in for it.
      const since = query.days ? new Date(Date.now() - query.days * 86_400_000) : new Date(0);
      if (query.unreadOnly || query.days) {
        params.set("$filter", [
          `receivedDateTime ge ${since.toISOString()}`,
          ...(query.unreadOnly ? ["isRead eq false"] : []),
        ].join(" and "));
      }
      params.set("$orderby", "receivedDateTime desc");
    }
    const path = query.mailbox ? "/me/mailFolders/inbox/messages" : "/me/messages";
    const result = await this.request<{ value: GraphMessage[] }>("GET", `${path}?${params}`);
    return (result.value ?? []).map(summary).sort((a, b) => b.date.localeCompare(a.date));
  }

  async read(id: string): Promise<MessageBody> {
    const data = await this.request<GraphMessage>("GET", `/me/messages/${encodeURIComponent(id)}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,isRead,hasAttachments,bodyPreview,body`);
    return {
      ...summary(data),
      to: (data.toRecipients ?? []).map(address),
      cc: (data.ccRecipients ?? []).map(address),
      text: data.body?.contentType?.toLowerCase() === "text" ? data.body.content ?? "" : "[No plain-text content.]",
      attachments: data.hasAttachments ? [{ name: "(has attachments)", bytes: 0 }] : [],
    };
  }

  async saveDraft(draft: Draft): Promise<{ id: string }> {
    if (draft.inReplyTo) {
      const created = await this.request<GraphMessage>("POST", `/me/messages/${encodeURIComponent(draft.inReplyTo)}/createReply`);
      if (!created.id) throw new Error(t("mail.outlook.replyDraftFailed"));
      await this.request("PATCH", `/me/messages/${encodeURIComponent(created.id)}`, message(draft));
      return { id: created.id };
    }
    const created = await this.request<GraphMessage>("POST", "/me/messages", message(draft));
    if (!created.id) throw new Error(t("mail.outlook.draftFailed"));
    return { id: created.id };
  }

  async deleteDraft(id: string): Promise<void> {
    const path = `/me/messages/${encodeURIComponent(id)}`;
    const current = await this.request<GraphMessage & { isDraft?: boolean }>("GET", `${path}?$select=id,isDraft`);
    if (current.isDraft !== true) throw new Error(t("mail.notFound"));
    // Folder-scoped deletion also fails closed if the user sent or moved it
    // between the check and this request.
    await this.request("DELETE", `/me/mailFolders/drafts/messages/${encodeURIComponent(id)}`);
  }

  /** Outlook's own names for Trash and Archive, or a folder the user named. */
  private async destination(to: MoveTarget): Promise<{ id: string; name: string }> {
    if (to.kind === "trash") return { id: "deleteditems", name: "Deleted Items" };
    if (to.kind === "archive") return { id: "archive", name: "Archive" };
    const result = await this.request<{ value: { id: string; displayName: string }[] }>("GET", "/me/mailFolders?$top=200&$select=id,displayName");
    const folders = result.value ?? [];
    const wanted = to.name.trim().toLowerCase();
    const hits = folders.filter((f) => f.displayName.toLowerCase() === wanted);
    if (hits.length === 1) return { id: hits[0]!.id, name: hits[0]!.displayName };
    throw new Error(t("mail.noSuchFolder", { name: to.name.slice(0, 80), names: folders.map((f) => f.displayName).join(", ").slice(0, 600) }));
  }

  async move(id: string, to: MoveTarget): Promise<Moved> {
    const path = `/me/messages/${encodeURIComponent(id)}`;
    const current = await this.request<GraphMessage>("GET", `${path}?$select=id,parentFolderId`);
    const target = await this.destination(to);
    if (!current.parentFolderId) throw new Error(t("mail.notFound"));
    const moved = await this.request<GraphMessage>("POST", `${path}/move`, { destinationId: target.id });
    return { id: moved.id ?? "", from: current.parentFolderId, to: target.name };
  }

  async moveBack(id: string, from: string): Promise<void> {
    await this.request("POST", `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: from });
  }

  async setRead(id: string, read: boolean): Promise<boolean> {
    const path = `/me/messages/${encodeURIComponent(id)}`;
    const current = await this.request<GraphMessage>("GET", `${path}?$select=id,isRead`);
    if (current.isRead !== read) await this.request("PATCH", path, { isRead: read });
    return current.isRead === true;
  }

  async send(draft: Draft): Promise<void> {
    try {
      if (draft.inReplyTo) {
        const created = await this.saveDraft(draft);
        await this.request("POST", `/me/messages/${encodeURIComponent(created.id)}/send`);
        return;
      }
      await this.request("POST", "/me/sendMail", { message: message(draft), saveToSentItems: true });
    } catch (err) {
      // A refusal (4xx) or no token means Outlook never took the message.
      const { status, beforeRequest } = (err ?? {}) as { status?: number; beforeRequest?: boolean };
      if (beforeRequest === true || (typeof status === "number" && status >= 400 && status < 500)) {
        throw new MailNotSent(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }
}
