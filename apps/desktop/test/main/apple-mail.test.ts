import { describe, expect, it } from "vitest";
import { MailNotSent } from "@vunemi/mail";
import { AppleMailAccount, listMailAppAccounts, messageRef, parseRef, MAIL_COMPOSE, MAIL_MARK, MAIL_MOVE, MAIL_SEARCH } from "../../src/main/apple-mail.js";

const INBOX = "␀inbox";
const TRASH = "␀trash";

/** Answers by the marker each template starts with, e.g. "// MAIL_SEARCH". */
function fake(answers: Record<string, unknown>) {
  const calls: { template: string; input: Record<string, unknown> }[] = [];
  const run = async (template: string, input: unknown) => {
    calls.push({ template, input: input as Record<string, unknown> });
    const marker = /^\/\/ (\w+)/.exec(template)![1]!;
    const answer = answers[marker] ?? {};
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

const ENTRY = { account: "iCloud", email: "test@example.com" };
const FOUND = { id: 7, path: [INBOX], from: { name: "A", address: "a@example.com" }, subject: "Hi", date: "2026-09-28T08:00:00.000Z", unread: true, hasAttachments: false, snippet: "hello" };

describe("Mail app accounts", () => {
  it("round-trips message ids and refuses anything else", () => {
    expect(parseRef(messageRef(["Work", "2026"], 42))).toEqual({ path: ["Work", "2026"], id: 42 });
    expect(() => parseRef("m3")).toThrow();
    expect(() => parseRef(JSON.stringify([["x"], "7"]))).toThrow();
  });

  it("scopes every script to the picked account and passes the query only as data", async () => {
    const { run, calls } = fake({ MAIL_SEARCH: { messages: [] } });
    const text = 'x"); do shell script("id';
    await new AppleMailAccount(run, ENTRY).search({ text, unreadOnly: true, days: 3, limit: 5 });
    expect(calls[0]!.template).toBe(MAIL_SEARCH);
    expect(MAIL_SEARCH).not.toContain(text);
    expect(calls[0]!.input).toMatchObject({ app: "Mail", account: "iCloud", path: [INBOX], text, unreadOnly: true, days: 3, limit: 5 });
  });

  it("searches a named mailbox by its path, and INBOX means the account's inbox", async () => {
    const { run, calls } = fake({ MAIL_SEARCH: { messages: [] } });
    const account = new AppleMailAccount(run, ENTRY);
    await account.search({ mailbox: "Work/2026" });
    await account.search({ mailbox: "INBOX" });
    expect(calls[0]!.input.path).toEqual(["Work", "2026"]);
    expect(calls[1]!.input.path).toEqual([INBOX]);
  });

  it("maps results to summaries with opaque ids and readable mailbox names", async () => {
    const { run } = fake({ MAIL_SEARCH: { messages: [FOUND] } });
    const [m] = await new AppleMailAccount(run, ENTRY).search({ limit: 5 });
    expect(m).toMatchObject({ from: { address: "a@example.com" }, subject: "Hi", unread: true, mailbox: "Inbox" });
    expect(parseRef(m!.id)).toEqual({ path: [INBOX], id: 7 });
  });

  it("lists only the accounts Mail has enabled", async () => {
    const { run } = fake({ MAIL_ACCOUNTS: { accounts: [{ name: "iCloud", emails: ["test@example.com"], enabled: true }, { name: "Old", emails: ["old@example.com"], enabled: false }] } });
    expect(await listMailAppAccounts(run)).toEqual([{ name: "iCloud", emails: ["test@example.com"] }]);
  });

  it("leaves out machines and the user's own messages from awaiting-reply", async () => {
    const { run } = fake({
      MAIL_AWAITING: { messages: [FOUND, { ...FOUND, id: 8, from: { address: "no-reply@example.com" } }, { ...FOUND, id: 9, from: { address: "Test@Example.com" } }] },
    });
    const list = await new AppleMailAccount(run, ENTRY).awaitingReply(7, 10);
    expect(list.map((m) => parseRef(m.id).id)).toEqual([7]);
  });

  it("saves drafts with save, from the account's address, never with send", async () => {
    const { run, calls } = fake({ MAIL_COMPOSE: { saved: true, id: 11 } });
    await new AppleMailAccount(run, ENTRY).saveDraft({ to: ["b@example.com"], subject: "s", body: "b", inReplyTo: messageRef([INBOX], 7) });
    expect(calls[0]!.template).toBe(MAIL_COMPOSE);
    expect(calls[0]!.input).toMatchObject({ mode: "draft", from: "test@example.com", to: ["b@example.com"], cc: [], reply: { path: [INBOX], id: 7 } });
  });

  it("reports a send refused before the hand-over as not sent", async () => {
    const { run } = fake({ MAIL_COMPOSE: { failed: "compose", reason: "no such address" } });
    await expect(new AppleMailAccount(run, ENTRY).send({ to: ["b@example.com"], subject: "s", body: "b" })).rejects.toBeInstanceOf(MailNotSent);
    const refused = fake({ MAIL_COMPOSE: { handedOver: false } });
    await expect(new AppleMailAccount(refused.run, ENTRY).send({ to: ["b@example.com"], subject: "s", body: "b" })).rejects.toBeInstanceOf(MailNotSent);
  });

  it("treats a failure at the send step as an unknown outcome", async () => {
    const { run } = fake({ MAIL_COMPOSE: { failed: "send", reason: "AppleEvent timed out" } });
    const err = await new AppleMailAccount(run, ENTRY).send({ to: ["b@example.com"], subject: "s", body: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MailNotSent);
  });

  it("moves to the account's trash and puts it back where it was", async () => {
    const { run, calls } = fake({ MAIL_MOVE: { id: 99, path: [TRASH], to: "Deleted Messages" } });
    const account = new AppleMailAccount(run, ENTRY);
    const moved = await account.move(messageRef([INBOX], 7), { kind: "trash" });
    expect(calls[0]!.template).toBe(MAIL_MOVE);
    expect(calls[0]!.input).toMatchObject({ account: "iCloud", path: [INBOX], id: 7, to: { kind: "trash" } });
    expect(moved.to).toBe("Deleted Messages");
    await account.moveBack(moved.id, moved.from);
    expect(calls[1]!.input).toMatchObject({ path: [TRASH], id: 99, to: { kind: "path", path: [INBOX] } });
  });

  it("offers no undo when Mail can't say where the message landed", async () => {
    const { run } = fake({ MAIL_MOVE: { id: 0, path: ["Archive"], to: "Archive" } });
    expect((await new AppleMailAccount(run, ENTRY).move(messageRef([INBOX], 7), { kind: "archive" })).id).toBe("");
  });

  it("says so when the account has no Archive", async () => {
    const { run } = fake({ MAIL_MOVE: { refused: "NO_ARCHIVE" } });
    await expect(new AppleMailAccount(run, ENTRY).move(messageRef([INBOX], 7), { kind: "archive" })).rejects.toThrow();
  });

  it("marks read and returns what it was", async () => {
    const { run, calls } = fake({ MAIL_MARK: { wasRead: false } });
    expect(await new AppleMailAccount(run, ENTRY).setRead(messageRef([INBOX], 7), true)).toBe(false);
    expect(calls[0]!.template).toBe(MAIL_MARK);
    expect(calls[0]!.input).toMatchObject({ read: true });
  });

  it("is not ready when Mail no longer has the account", async () => {
    const { run } = fake({ MAIL_READY: { ready: false } });
    expect(await new AppleMailAccount(run, ENTRY).ready()).toBe(false);
  });
});

describe("the Mail scripts", () => {
  it("parse as JavaScript", () => {
    for (const template of [MAIL_SEARCH, MAIL_COMPOSE, MAIL_MOVE, MAIL_MARK]) {
      // JXA globals are absent here; compiling is enough to catch a broken template.
      expect(() => new Function(template)).not.toThrow();
    }
  });

  it("never read a password or delete a message", () => {
    for (const template of [MAIL_SEARCH, MAIL_COMPOSE, MAIL_MOVE, MAIL_MARK]) {
      expect(template).not.toMatch(/password|\.delete\(|app\.delete/);
    }
  });
});
