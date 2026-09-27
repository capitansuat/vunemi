import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphMailAccount } from "../src/graph-account.js";
import { MailNotSent } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

describe("Outlook Graph transport", () => {
  it("reads a message as text with an immutable id", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: "A/B+", subject: "Toplantı", receivedDateTime: "2026-09-23T09:00:00Z",
      from: { emailAddress: { address: "a@example.com" } },
      body: { contentType: "text", content: "Yarın görüşelim." },
      toRecipients: [{ emailAddress: { address: "b@example.com" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const account = new GraphMailAccount("b@example.com", async () => "token");
    const message = await account.read("A/B+");
    expect(message.text).toBe("Yarın görüşelim.");
    expect(message.id).toBe("A/B+");
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/me/messages/A%2FB%2B");
    expect((options.headers as Record<string, string>).Prefer).toContain("ImmutableId");
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer token");
  });

  it("creates a reply draft before sending, preserving the thread", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      calls.push(`${options.method} ${new URL(url).pathname}`);
      return new Response(calls.length === 1 ? JSON.stringify({ id: "draft-1" }) : "", {
        status: calls.length === 1 ? 201 : 202,
        ...(calls.length === 1 && { headers: { "content-type": "application/json" } }),
      });
    }));
    const account = new GraphMailAccount("b@example.com", async () => "token");
    await account.send({ to: ["a@example.com"], subject: "Yanıt", body: "Tamam", inReplyTo: "original-1" });
    expect(calls).toEqual([
      "POST /v1.0/me/messages/original-1/createReply",
      "PATCH /v1.0/me/messages/draft-1",
      "POST /v1.0/me/messages/draft-1/send",
    ]);
  });

  it("deletes only a message still marked as a draft", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      calls.push(`${options.method} ${new URL(url).pathname}`);
      if (options.method === "GET") return new Response(JSON.stringify({ id: "draft/1", isDraft: true }), { status: 200 });
      return new Response(null, { status: 204 });
    }));
    await new GraphMailAccount("b@example.com", async () => "token").deleteDraft("draft/1");
    expect(calls).toEqual(["GET /v1.0/me/messages/draft%2F1", "DELETE /v1.0/me/mailFolders/drafts/messages/draft%2F1"]);
  });

  it("refuses to delete a draft that has already been sent", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "draft/1", isDraft: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new GraphMailAccount("b@example.com", async () => "token").deleteDraft("draft/1")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  describe("searching the way Graph allows", () => {
    /**
     * Graph's documented rule for $filter with $orderby on messages:
     * every $orderby property must appear in $filter, in the same order,
     * before any property that is not sorted on. Anything else is a 400
     * InefficientFilter. This fake enforces exactly that, so a query shape
     * Graph would refuse fails here too.
     */
    const strictGraph = () => {
      const seen: URL[] = [];
      vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
        const url = new URL(raw);
        seen.push(url);
        const props = (text: string | null, split: RegExp) =>
          (text ?? "").split(split).map((part) => part.trim().split(/\s+/)[0]!).filter(Boolean);
        const sorted = props(url.searchParams.get("$orderby"), /,/);
        const filtered = props(url.searchParams.get("$filter"), /\s+and\s+/i);
        if (url.searchParams.has("$filter") && sorted.length && sorted.some((prop, i) => filtered[i] !== prop)) {
          return new Response(JSON.stringify({ error: { code: "InefficientFilter" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }));
      return seen;
    };

    const account = () => new GraphMailAccount("b@example.com", async () => "token");

    it.each([
      ["okunmamışlar", { unreadOnly: true }],
      ["son günler", { days: 3 }],
      ["son günlerin okunmamışları", { unreadOnly: true, days: 3 }],
      ["filtresiz", {}],
    ])("asks for %s in a shape Graph accepts", async (_name, query) => {
      const seen = strictGraph();
      await expect(account().search(query)).resolves.toEqual([]);
      // Newest first, still: sorting is the reason for the constraint.
      expect(seen[0]!.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    });

    it("still filters for unread when it has to name a date", async () => {
      const seen = strictGraph();
      await account().search({ unreadOnly: true });
      expect(seen[0]!.searchParams.get("$filter")).toContain("isRead eq false");
    });
  });
});


describe("Outlook send outcomes", () => {
  const draft = { to: ["a@example.com"], subject: "Test", body: "Synthetic" };

  it("calls a refused request not sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    const account = new GraphMailAccount("b@example.com", async () => "token");
    await expect(account.send(draft)).rejects.toBeInstanceOf(MailNotSent);
  });

  it("calls a missing sign-in not sent without asking Outlook", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const account = new GraphMailAccount("b@example.com", async () => { throw new Error("signed out"); });
    await expect(account.send(draft)).rejects.toBeInstanceOf(MailNotSent);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves a server error or a lost answer uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const account = new GraphMailAccount("b@example.com", async () => "token");
    const serverError = await account.send(draft).catch((err: unknown) => err);
    expect(serverError).toBeInstanceOf(Error);
    expect(serverError).not.toBeInstanceOf(MailNotSent);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const lost = await account.send(draft).catch((err: unknown) => err);
    expect(lost).toBeInstanceOf(TypeError);
  });
});

describe("Outlook messages waiting for a reply", () => {
  it("drops replied ones, machines and mail not addressed to me, and asks Outlook for the reply mark", async () => {
    const person = (address: string) => ({ emailAddress: { address } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: [
      { id: "1", from: person("ayse@example.com"), toRecipients: [person("b@example.com")], receivedDateTime: "2026-09-20T10:00:00Z" },
      { id: "2", from: person("mehmet@example.com"), toRecipients: [person("b@example.com")], receivedDateTime: "2026-09-20T09:00:00Z",
        singleValueExtendedProperties: [{ id: "Integer 0x1081", value: "102" }] },
      { id: "3", from: person("noreply@shop.example"), toRecipients: [person("b@example.com")], receivedDateTime: "2026-09-20T08:00:00Z" },
      { id: "4", from: person("list@example.com"), toRecipients: [person("all@example.com")], receivedDateTime: "2026-09-20T07:00:00Z" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const account = new GraphMailAccount("b@example.com", async () => "token");
    const list = await account.awaitingReply(7, 10);
    expect(list.map((m) => m.id)).toEqual(["1"]);
    const url = decodeURIComponent(String((fetcher.mock.calls[0] as unknown as [string])[0]).replace(/\+/g, " "));
    expect(url).toContain("/me/mailFolders/inbox/messages");
    expect(url).toContain("Integer 0x1081");
  });

  it("moves to Deleted Items and back to the folder it came from, and marks read", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ method: String(options.method), path, ...(options.body && { body: JSON.parse(String(options.body)) }) });
      const json = options.method === "GET" ? { id: "m1", parentFolderId: "inbox-id", isRead: false } : options.method === "POST" ? { id: "m1" } : null;
      return json ? new Response(JSON.stringify(json), { status: 200 }) : new Response(null, { status: 204 });
    }));
    const account = new GraphMailAccount("b@example.com", async () => "token");
    const moved = await account.move("m1", { kind: "trash" });
    expect(moved).toEqual({ id: "m1", from: "inbox-id", to: "Deleted Items" });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/v1.0/me/messages/m1/move", body: { destinationId: "deleteditems" } });
    await account.moveBack(moved.id, moved.from);
    expect(calls.at(-1)!.body).toEqual({ destinationId: "inbox-id" });
    expect(await account.setRead("m1", true)).toBe(false);
    expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/v1.0/me/messages/m1", body: { isRead: true } });
  });
});
