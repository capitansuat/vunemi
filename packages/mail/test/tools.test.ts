/**
 * The mail tools. The interesting cases are the ones where the model is
 * wrong or the mail is hostile: an address that isn't one, a code the model
 * would happily repeat, and a send that must not have happened yet when the
 * tool says it did.
 */
import type { Produced, ToolContext, ToolDef } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailTools, MailAccounts, Outbox, type Draft, type MailAccount, type MessageBody } from "../src/index.js";

const undos: { label: string; run: () => Promise<void> | void }[] = [];

const made: Produced[] = [];

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: (label, run) => undos.push({ label, run }),
  attach: () => {},
  produced: (item) => made.push(item),
});

function fixture() {
  const sent: Draft[] = [];
  const drafts: Draft[] = [];
  const deleted: string[] = [];
  const moves: { id: string; to: string }[] = [];
  let connected = true;
  const body: MessageBody = {
    id: "m1",
    from: { name: "Banka", address: "security@bank.example" },
    to: [{ address: "test@example.com" }],
    cc: [],
    subject: "Giriş doğrulama",
    date: "2026-09-23T09:00:00+03:00",
    mailbox: "Gelen Kutusu",
    unread: true,
    hasAttachments: false,
    snippet: "Doğrulama kodunuz: 902417",
    text: "Doğrulama kodunuz: 902417\nOturum açmak için: https://bank.example/signin?token=8f3b2a91c7d5e604",
    attachments: [],
  };

  const account: MailAccount = {
    label: "Test <test@example.com>",
    ready: async () => connected,
    search: async () => [body],
    read: async () => body,
    saveDraft: async (d) => {
      drafts.push(d);
      return { id: "d1" };
    },
    deleteDraft: async (id) => { deleted.push(id); },
    send: async (d) => {
      sent.push(d);
    },
    move: async (id, to) => {
      moves.push({ id, to: to.kind === "folder" ? to.name : to.kind });
      return { id: `${id}-moved`, from: "INBOX", to: to.kind === "trash" ? "Trash" : to.kind === "archive" ? "Archive" : "Work" };
    },
    moveBack: async (id, from) => {
      moves.push({ id, to: from });
    },
    setRead: async (_id, read) => {
      const was = !body.unread;
      body.unread = !read;
      return was;
    },
  };

  const accounts = new MailAccounts();
  accounts.add({ id: "a1", label: "Test <test@example.com>", account });

  const outbox = new Outbox(45_000);
  const tools = new Map(createMailTools({ accounts, outbox }).map((t) => [t.name, t]));
  return { tools, sent, drafts, deleted, moves, body, outbox, accounts, disconnect: () => (connected = false) };
}

const run = (tools: Map<string, ToolDef>, name: string, args: Record<string, unknown> = {}) =>
  tools.get(name)!.run(args as never, ctx());

describe("reading mail", () => {
  it("treats every message as somebody else's writing", () => {
    const { tools } = fixture();
    for (const name of ["mail_search", "mail_read"]) {
      expect(tools.get(name)!.untrustedOutput).toBe(true);
      expect(tools.get(name)!.actionClass).toBe("read");
    }
  });

  it("never shows the model a one-time code, in the list or in the message", async () => {
    const { tools } = fixture();
    const list = await run(tools, "mail_search", { text: "banka" });
    expect(list).not.toContain("902417");

    const opened = await run(tools, "mail_read", { id: "a1::m1" });
    expect(opened).not.toContain("902417");
    expect(opened).not.toContain("8f3b2a91c7d5e604");
    // Who it is from still reads, so the agent can report what arrived.
    expect(opened).toContain("security@bank.example");
    // And it is told not to go asking the user for the code.
    expect(opened).toMatch(/do not ask them for the code/);
  });

  it("says the account is not connected instead of reporting an empty inbox", async () => {
    const { tools, disconnect } = fixture();
    disconnect();
    await expect(run(tools, "mail_search", {})).rejects.toThrow(/bağlı değil/);
    await expect(run(tools, "mail_read", { id: "a1::m1" })).rejects.toThrow(/bağlı değil/);
  });
});

describe("writing mail", () => {
  beforeEach(() => {
    undos.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("treats both a remote draft and a send as outbound", () => {
    const { tools } = fixture();
    expect(tools.get("mail_draft")!.actionClass).toBe("outbound");
    expect(tools.get("mail_send")!.actionClass).toBe("outbound");
    // A text over iMessage to an email address is not an email.
    const avoid = tools.get("mail_send")!.avoidFor!;
    expect(avoid.test("iMessage ile test@example.com adresine mesaj gönder")).toBe(true);
    expect(avoid.test("Ayşe'ye e-posta gönder")).toBe(false);
  });

  it("announces the draft it saved, and in which mailbox", async () => {
    made.length = 0;
    const { tools } = fixture();
    await run(tools, "mail_draft", { to: ["ayse@example.com"], subject: "Merhaba", body: "…" });
    expect(made).toEqual([{ kind: "draft", account: "Test <test@example.com>", subject: "Merhaba", to: ["ayse@example.com"] }]);
  });

  it("offers a draft undo tied to the created draft id", async () => {
    const { tools, deleted } = fixture();
    await run(tools, "mail_draft", { to: ["ayse@example.com"], subject: "Merhaba", body: "…" });
    expect(undos).toHaveLength(1);
    await undos[0]!.run();
    expect(deleted).toEqual(["d1"]);
  });

  it("announces nothing for a send: it is held, and may never go", async () => {
    made.length = 0;
    const { tools } = fixture();
    await run(tools, "mail_send", { to: ["ayse@example.com"], subject: "Rapor", body: "…" });
    expect(made).toEqual([]);
  });

  it("puts a draft in drafts and sends nothing", async () => {
    const { tools, drafts, sent } = fixture();
    const out = await run(tools, "mail_draft", { to: ["ayse@example.com"], subject: "Merhaba", body: "…" });
    expect(drafts).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(out).toMatch(/It was not sent/);
  });

  it("has not sent anything at the moment it reports the send", async () => {
    const { tools, sent, outbox } = fixture();
    const out = await run(tools, "mail_send", { to: ["ayse@example.com"], subject: "Rapor", body: "ekte" });
    // The claim in the text is "not sent yet", and it has to be true.
    expect(sent).toEqual([]);
    expect(outbox.pending).toHaveLength(1);
    expect(out).toMatch(/^Not sent yet\..* will go from .* in \d+ seconds/);

    await vi.advanceTimersByTimeAsync(46_000);
    expect(sent.map((d) => d.subject)).toEqual(["Rapor"]);
  });

  it("offers an undo that really stops the message", async () => {
    const { tools, sent } = fixture();
    await run(tools, "mail_send", { to: ["ayse@example.com"], subject: "Yanlış", body: "…" });
    expect(undos).toHaveLength(1);

    await undos[0]!.run();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
  });

  it("doesn't claim a message went when the outbox already took it back", async () => {
    const { tools, sent, outbox } = fixture();
    await run(tools, "mail_send", { to: ["ayse@example.com"], subject: "Vazgeçtim", body: "…" });
    expect(await outbox.cancel(outbox.pending[0]!.id)).toBe(true);

    await expect(undos[0]!.run()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
  });

  it("admits it when the undo comes too late", async () => {
    const { tools } = fixture();
    await run(tools, "mail_send", { to: ["ayse@example.com"], subject: "Gitti", body: "…" });
    await vi.advanceTimersByTimeAsync(46_000);
    await expect(undos[0]!.run()).rejects.toThrow(/çoktan gitti/);
  });

  it("refuses a recipient that isn't an address by name, instead of quietly dropping them", async () => {
    // Dropping one would send to fewer people than the user meant, with nothing to show for it.
    const { tools, drafts, outbox } = fixture();
    const to = ["ayse@example.com", "Ayşe'ye gönder", "mehmet@example.com"];
    await expect(run(tools, "mail_draft", { to, subject: "x", body: "y" })).rejects.toThrow(/Ayşe'ye gönder/);
    await expect(run(tools, "mail_send", { to, subject: "x", body: "y" })).rejects.toThrow(/Ayşe'ye gönder/);
    expect(drafts).toEqual([]);
    expect(outbox.pending).toEqual([]);
    await run(tools, "mail_draft", { to: ["ayse@example.com", " mehmet@example.com "], subject: "x", body: "y" });
    expect(drafts[0]!.to).toEqual(["ayse@example.com", "mehmet@example.com"]);
  });

  it("flags the same message to the same people on the card, as a likely retry", async () => {
    const { tools } = fixture();
    const send = tools.get("mail_send")!;
    const args = { to: ["ayse@example.com"], subject: "Toplantı", body: "Yarın 10'da." };
    expect(await send.preview!(args)).not.toMatch(/⚠/);
    await run(tools, "mail_send", args);
    expect(await send.preview!(args)).toMatch(/⚠/);
    expect(await send.preview!({ ...args, body: "Başka bir şey" })).not.toMatch(/⚠/);
  });

  it("refuses to send with no recipient rather than sending to nobody", async () => {
    const { tools, outbox } = fixture();
    await expect(run(tools, "mail_send", { to: ["bir isim"], subject: "x", body: "y" })).rejects.toThrow(/alıcı/);
    expect(outbox.pending).toEqual([]);
  });

  it("does not silently turn a reply with a stale id into a new message", async () => {
    const { tools, outbox } = fixture();
    await expect(run(tools, "mail_send", {
      to: ["x@example.com"], subject: "Re: Test", body: "Yanıt", inReplyTo: "unknown::old",
    })).rejects.toThrow();
    expect(outbox.pending).toEqual([]);
  });

  it("shows the user the whole message before they approve it", async () => {
    const { tools } = fixture();
    const preview = await tools.get("mail_send")!.preview!({
      to: ["ayse@example.com"],
      subject: "Rapor",
      body: "Ekteki rapor hazır.",
    } as never);
    expect(preview).toContain("ayse@example.com");
    expect(preview).toContain("Rapor");
    expect(preview).toContain("Ekteki rapor hazır.");
  });
});

describe("more than one mailbox", () => {
  /** A second account, so the ambiguity is real rather than theoretical. */
  function two() {
    const base = fixture();
    const sentFromWork: Draft[] = [];
    base.accounts.add({
      id: "a2",
      label: "İş <test@firma.com>",
      account: {
        label: "İş <test@firma.com>",
        ready: async () => true,
        search: async () => [
          {
            id: "w9",
            from: { address: "patron@firma.com" },
            subject: "Bütçe",
            date: "2026-09-24T08:00:00+03:00",
            mailbox: "Gelen Kutusu",
            unread: false,
            hasAttachments: false,
            snippet: "Rakamlar ekte",
          },
        ],
        read: async () => {
          throw new Error("unused");
        },
        saveDraft: async () => ({ id: "d2" }),
        send: async (d) => {
          sentFromWork.push(d);
        },
      },
    });
    return { ...base, sentFromWork };
  }

  beforeEach(() => {
    undos.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("does not multiply the tools with the accounts", () => {
    const { tools } = two();
    expect([...tools.keys()].sort()).toEqual(["mail_archive", "mail_awaiting_reply", "mail_draft", "mail_mark", "mail_move", "mail_read", "mail_search", "mail_send", "mail_trash"]);
  });

  it("searches every mailbox at once, newest first, saying which is which", async () => {
    const { tools } = two();
    const out = await run(tools, "mail_search", {});
    expect(out).toContain("Bütçe");
    expect(out).toContain("Giriş doğrulama");
    expect(out).toContain("İş <test@firma.com>");
    // 24 September is newer than 23 September, so it leads.
    expect(out.indexOf("Bütçe")).toBeLessThan(out.indexOf("Giriş doğrulama"));
  });

  it("gives each message a short id that already knows its mailbox", async () => {
    const { tools, sentFromWork } = two();
    const out = await run(tools, "mail_search", {});
    // Gemma 4 E2B copied the long "account::base64" form only up to its "::".
    expect([...out.matchAll(/id: (\S+)/g)].map((m) => m[1])).toEqual(["m1", "m2"]);
    expect(await run(tools, "mail_search", {})).toContain("id: m1");
    await run(tools, "mail_send", { to: ["patron@firma.com"], subject: "Re: Bütçe", body: "…", inReplyTo: "m1" });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(sentFromWork[0]!.inReplyTo).toBe("w9");
  });

  it("refuses to guess which mailbox to send from", async () => {
    const { tools, sent, sentFromWork } = two();
    await expect(run(tools, "mail_send", { to: ["x@example.com"], subject: "?", body: "…" })).rejects.toThrow(
      /Hangi hesaptan/,
    );
    expect(sent).toEqual([]);
    expect(sentFromWork).toEqual([]);
  });

  it("sends from the one it was told to, by id or by name", async () => {
    const { tools, sentFromWork } = two();
    await run(tools, "mail_send", { to: ["x@example.com"], subject: "İşten", body: "…", account: "a2" });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(sentFromWork.map((d) => d.subject)).toEqual(["İşten"]);
  });

  it("replies from the mailbox the message arrived in, without being told", async () => {
    const { tools, sentFromWork, sent } = two();
    await run(tools, "mail_send", { to: ["patron@firma.com"], subject: "Re: Bütçe", body: "…", inReplyTo: "a2::w9" });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(sentFromWork.map((d) => d.subject)).toEqual(["Re: Bütçe"]);
    expect(sent).toEqual([]);
    // The transport is handed the message's own id, not the qualified one.
    expect(sentFromWork[0]!.inReplyTo).toBe("w9");
  });

  it("names the mailboxes when the model asks for one that isn't there", async () => {
    const { tools } = two();
    await expect(
      run(tools, "mail_send", { to: ["x@example.com"], subject: "?", body: "…", account: "hotmail" }),
    ).rejects.toThrow(/İş <test@firma.com>/);
  });

  it("still answers when one mailbox is down, and says which", async () => {
    const { tools, disconnect } = two();
    disconnect(); // the first account only
    const out = await run(tools, "mail_search", {});
    expect(out).toContain("Bütçe");
    expect(out).toMatch(/is not connected/);
  });
});

describe("mail_awaiting_reply", () => {
  const base = (label: string, extra: Partial<MailAccount> = {}): MailAccount => ({
    label, ready: async () => true, search: async () => [], read: async () => { throw new Error("unused"); },
    saveDraft: async () => ({ id: "d" }), send: async () => {}, ...extra,
  });

  it("lists what people are waiting on, says how it judged, and names a mailbox it couldn't check", async () => {
    const accounts = new MailAccounts();
    const asked: number[] = [];
    accounts.add({ id: "a1", label: "Home", account: base("Home", {
      awaitingReply: async (days) => {
        asked.push(days);
        return [{ id: "m1", from: { name: "Ayşe", address: "ayse@example.com" }, subject: "Cuma?", date: "2026-09-24T09:00:00Z", mailbox: "INBOX", unread: false, hasAttachments: false, snippet: "" }];
      },
    }) });
    accounts.add({ id: "a2", label: "Old", account: base("Old") });
    const tool = createMailTools({ accounts, outbox: new Outbox() }).find((t) => t.name === "mail_awaiting_reply")!;
    expect(tool.actionClass).toBe("read");
    const out = String(await tool.run({ days: 90 }, ctx()));
    expect(asked).toEqual([30]);
    expect(out).toContain("Cuma?");
    expect(out).toContain("answered mark");
    expect(out).toContain("Old was not checked");
  });

  it("says plainly when nothing is waiting", async () => {
    const accounts = new MailAccounts();
    accounts.add({ id: "a1", label: "Home", account: base("Home", { awaitingReply: async () => [] }) });
    const tool = createMailTools({ accounts, outbox: new Outbox() }).find((t) => t.name === "mail_awaiting_reply")!;
    expect(String(await tool.run({}, ctx()))).toMatch(/^Nothing from the last 7 days/);
  });
});

describe("organising mail", () => {
  beforeEach(() => { undos.length = 0; });

  it("names the message on the card, moves it on approval, and puts it back", async () => {
    const { tools, moves } = fixture();
    await run(tools, "mail_search", { text: "banka" });
    for (const name of ["mail_trash", "mail_archive", "mail_move"]) {
      expect(tools.get(name)!.alwaysAsk).toBe(true);
      expect(tools.get(name)!.actionClass).toBe("write-local");
    }
    expect(await tools.get("mail_trash")!.preview!({ id: "a1::m1" } as never)).toContain("Giriş doğrulama");
    const out = await run(tools, "mail_trash", { id: "a1::m1" });
    expect(out).toMatch(/Moved "Giriş doğrulama" to Trash/);
    expect(out).toMatch(/Its id there: m2\b/);
    expect(moves).toEqual([{ id: "m1", to: "trash" }]);
    await undos.at(-1)!.run();
    expect(moves.at(-1)).toEqual({ id: "m1-moved", to: "INBOX" });
    await run(tools, "mail_move", { id: "a1::m1", folder: "Work" });
    expect(moves.at(-1)).toEqual({ id: "m1", to: "Work" });
  });

  it("marks read and back, and says so when nothing changes", async () => {
    const { tools, body } = fixture();
    expect(await run(tools, "mail_mark", { id: "a1::m1", read: true })).toMatch(/marked read/);
    expect(body.unread).toBe(false);
    expect(await run(tools, "mail_mark", { id: "a1::m1", read: true })).toMatch(/Nothing was changed/);
    await undos[0]!.run();
    expect(body.unread).toBe(true);
  });
});
