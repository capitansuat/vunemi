import { describe, expect, it, vi } from "vitest";
import { automated, ImapSmtpAccount, gmailAppPassword, gmailConfig, imapTls, validateMailConfig } from "../src/imap-account.js";

const valid = {
  email: "user@example.com", user: "user", imapHost: "imap.example.com", imapPort: 993,
  smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false,
};

describe("manual mail account", () => {
  it("accepts an encrypted IMAP and STARTTLS SMTP configuration", () => {
    expect(validateMailConfig(valid)).toEqual(valid);
  });

  it("rejects malformed ports and header injection before connecting", () => {
    expect(() => validateMailConfig({ ...valid, smtpPort: 0 })).toThrow();
    expect(() => validateMailConfig({ ...valid, email: "user@example.com\r\nBcc: attacker@example.com" })).toThrow();
    expect(() => validateMailConfig({ ...valid, imapHost: "imap.example.com\n" })).toThrow();
  });
});

describe("Gmail application-password setup", () => {
  it("uses Google's TLS servers and the address as the login", () => {
    expect(gmailConfig("user@gmail.com")).toEqual({
      email: "user@gmail.com", user: "user@gmail.com", imapHost: "imap.gmail.com", imapPort: 993,
      smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true,
    });
    expect(gmailAppPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
  });

  it("rejects a missing password and invalid address before connecting", () => {
    expect(() => gmailAppPassword("   ")).toThrow(/uygulama parolasını/);
    expect(() => gmailConfig("invalid\r\nBcc: x")).toThrow();
  });
});

describe("how IMAP is encrypted", () => {
  it("uses TLS from the first byte on 993", () => {
    expect(imapTls({ ...valid, imapPort: 993 })).toEqual({ secure: true, doSTARTTLS: false });
  });

  it("requires STARTTLS on 143 and any other port, rather than failing to connect", () => {
    for (const imapPort of [143, 1143]) {
      expect(imapTls({ ...valid, imapPort })).toEqual({ secure: false, doSTARTTLS: true });
    }
  });

  it("never leaves encryption to chance", () => {
    // Left unset, the library upgrades only if the server offers to — and an
    // attacker in the middle can simply not offer. Every port must decide.
    for (const imapPort of [143, 993, 1143]) {
      expect(typeof imapTls({ ...valid, imapPort }).doSTARTTLS).toBe("boolean");
    }
  });
});


describe("draft undo safety", () => {
  const id = Buffer.from(JSON.stringify({ mailbox: "[Gmail]/Drafts", validity: "42", uid: 12 })).toString("base64url");

  function fixture(validity = 42n, specialUse = "\\Drafts", flags = new Set(["\\Draft"])) {
    const account = new ImapSmtpAccount(valid, () => "password");
    const client = {
      isClosed: true,
      // As the library leaves it after opening: no special-use flag here;
      // that comes from the folder list.
      mailbox: { uidValidity: validity },
      list: vi.fn(async () => [{ path: "[Gmail]/Drafts", specialUse }, { path: "Drafts-old" }]),
      connect: vi.fn(async () => {}),
      getMailboxLock: vi.fn(async () => ({ release: () => {} })),
      fetchOne: vi.fn(async () => ({ flags })),
      messageDelete: vi.fn(async () => true),
    };
    vi.spyOn(account as unknown as { client: () => unknown }, "client").mockReturnValue(client);
    return { account, client };
  }

  it("deletes the exact UID only in the original Drafts mailbox", async () => {
    const { account, client } = fixture();
    await account.deleteDraft(id);
    expect(client.getMailboxLock).toHaveBeenCalledWith("[Gmail]/Drafts");
    expect(client.messageDelete).toHaveBeenCalledWith("12", { uid: true });
  });

  it("does not delete when the mailbox changed or the message is no longer a draft", async () => {
    for (const setup of [fixture(43n), fixture(42n, "\\Sent"), fixture(42n, "\\Drafts", new Set(["\\Seen"]))]) {
      await expect(setup.account.deleteDraft(id)).rejects.toThrow();
      expect(setup.client.messageDelete).not.toHaveBeenCalled();
    }
  });
});


describe("moving and marking", () => {
  const id = Buffer.from(JSON.stringify({ mailbox: "INBOX", validity: "7", uid: 5 })).toString("base64url");
  const decode = (raw: string) => JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));

  function fixture(folders: { path: string; name: string; specialUse?: string; flags?: Set<string> }[], moved: unknown = { uidValidity: 9n, uidMap: new Map([[5, 31]]) }) {
    const account = new ImapSmtpAccount(valid, () => "password");
    const client = {
      isClosed: true,
      mailbox: { uidValidity: 7n },
      list: vi.fn(async () => folders),
      connect: vi.fn(async () => {}),
      getMailboxLock: vi.fn(async () => ({ release: () => {} })),
      fetchOne: vi.fn(async () => ({ envelope: { messageId: "<m@x>" }, flags: new Set<string>() })),
      messageMove: vi.fn(async () => moved),
      messageFlagsAdd: vi.fn(async () => true),
      messageFlagsRemove: vi.fn(async () => true),
      search: vi.fn(async () => [40, 41]),
    };
    vi.spyOn(account as unknown as { client: () => unknown }, "client").mockReturnValue(client);
    return { account, client };
  }
  const gmail = [
    { path: "INBOX", name: "INBOX" },
    { path: "[Gmail]", name: "[Gmail]", flags: new Set(["\\Noselect"]) },
    { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash" },
    { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
    { path: "Work/Invoices", name: "Invoices" },
  ];

  it("moves to the server's own Trash and archive, and finds the message where it landed", async () => {
    const { account, client } = fixture(gmail);
    const trashed = await account.move(id, { kind: "trash" });
    expect(client.messageMove).toHaveBeenCalledWith("5", "[Gmail]/Trash", { uid: true });
    expect(decode(trashed.id)).toEqual({ mailbox: "[Gmail]/Trash", validity: "9", uid: 31 });
    expect(trashed.from).toBe("INBOX");
    await account.move(id, { kind: "archive" });
    expect(client.messageMove).toHaveBeenLastCalledWith("5", "[Gmail]/All Mail", { uid: true });
    await account.move(id, { kind: "folder", name: "invoices" });
    expect(client.messageMove).toHaveBeenLastCalledWith("5", "Work/Invoices", { uid: true });
  });

  it("finds a moved message by its Message-ID when the server gives no new UID", async () => {
    const { account, client } = fixture(gmail, { uidValidity: undefined });
    const moved = await account.move(id, { kind: "trash" });
    expect(client.search).toHaveBeenCalledWith({ header: { "message-id": "<m@x>" } }, { uid: true });
    expect(decode(moved.id).uid).toBe(41);
  });

  it("refuses a folder it can't name exactly, a missing Trash, and the folder it is already in", async () => {
    const { account, client } = fixture([{ path: "INBOX", name: "INBOX" }, { path: "A/Old", name: "Old" }, { path: "B/Old", name: "Old" }]);
    await expect(account.move(id, { kind: "folder", name: "Old" })).rejects.toThrow(/A\/Old, B\/Old/);
    await expect(account.move(id, { kind: "trash" })).rejects.toThrow();
    await expect(account.move(id, { kind: "folder", name: "INBOX" })).rejects.toThrow();
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("marks read, and says what it was before", async () => {
    const { account, client } = fixture(gmail);
    expect(await account.setRead(id, true)).toBe(false);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("5", ["\\Seen"], { uid: true });
    expect(await account.setRead(id, false)).toBe(false);
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });
});

describe("SMTP recipient outcomes", () => {
  it("reports partial acceptance instead of treating it as a complete send", async () => {
    const account = new ImapSmtpAccount(valid, () => "password");
    const transport = {
      verify: vi.fn(async () => true),
      sendMail: vi.fn(async () => ({ accepted: ["a@example.com"], rejected: ["b@example.com"] })),
      close: vi.fn(),
    };
    vi.spyOn(account as unknown as { mailer: () => unknown }, "mailer").mockReturnValue(transport);
    await expect(account.send({ to: ["a@example.com", "b@example.com"], subject: "Test", body: "Hello" }))
      .rejects.toThrow(/a@example.com.*b@example.com/);
    expect(transport.close).toHaveBeenCalledOnce();
  });
});

describe("messages waiting for a reply", () => {
  const message = (uid: number, from: string, extra: { headers?: string; messageId?: string } = {}) => ({
    uid,
    envelope: { from: [{ address: from }], subject: `S${uid}`, date: new Date(Date.UTC(2026, 8, 20, 0, uid)), messageId: extra.messageId ?? `<m${uid}@x>` },
    flags: new Set<string>(),
    headers: Buffer.from(extra.headers ?? ""),
  });

  function fixture(sentReplies: string[] = []) {
    const account = new ImapSmtpAccount(valid, () => "password");
    const searches: unknown[] = [];
    const client = {
      isClosed: true,
      mailbox: { uidValidity: 7n },
      list: vi.fn(async () => [{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]),
      connect: vi.fn(async () => {}),
      getMailboxLock: vi.fn(async () => ({ release: () => {} })),
      search: vi.fn(async (criteria: { header?: Record<string, string> }) => {
        searches.push(criteria);
        if (criteria.header) return sentReplies.includes(criteria.header["in-reply-to"]!) ? [99] : [];
        return [1, 2, 3, 4, 5, 6];
      }),
      fetchAll: vi.fn(async () => [
        message(1, "ayse@example.com"),
        message(2, "news@shop.example", { headers: "List-Unsubscribe: <mailto:x>\r\n" }),
        message(3, "no-reply@bank.example"),
        message(4, "user@example.com"),
        message(5, "mehmet@example.com", { messageId: "<answered@x>" }),
        message(6, "alerts@x.example", { headers: "Auto-Submitted: auto-generated\r\n" }),
      ]),
    };
    vi.spyOn(account as unknown as { client: () => unknown }, "client").mockReturnValue(client);
    return { account, client, searches };
  }

  it("keeps people's unanswered messages to me and drops lists, machines, myself and ones answered from Sent", async () => {
    const { account, searches } = fixture(["<answered@x>"]);
    const list = await account.awaitingReply(7, 10);
    expect(list.map((m) => m.from.address)).toEqual(["ayse@example.com"]);
    expect(searches[0]).toMatchObject({ answered: false, to: "user@example.com" });
  });

  it("recognises machine mail by its headers", () => {
    expect(automated(Buffer.from("Precedence: bulk\r\n"))).toBe(true);
    expect(automated(Buffer.from("Auto-Submitted: no\r\n"))).toBe(false);
    expect(automated(Buffer.from("Subject: hi\r\n"))).toBe(false);
    expect(automated(undefined)).toBe(false);
  });
});
