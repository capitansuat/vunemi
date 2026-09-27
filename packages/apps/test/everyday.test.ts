import { mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { Produced, ToolContext } from "@vunemi/agent-core";
import { Roots } from "@vunemi/files";
import {
  BROWSER_OPEN, BROWSER_TABS, CONTACTS_SEARCH, createEverydayTools, MESSAGES_SEND, MUSIC_CONTROL, MUSIC_NOW, PHOTOS_SEARCH, PHOTOS_THUMBS, recipient,
} from "../src/everyday.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-everyday-")));
const allowed = join(base, "allowed");
mkdirSync(allowed);
const ctx = (produced: Produced[] = []) => ({ signal: new AbortController().signal, produced: (p: Produced) => produced.push(p) }) as unknown as ToolContext;
const tools = (run = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}))) => {
  const list = createEverydayTools(run, new Roots([allowed]));
  return { run, get: (name: string) => list.find((tool) => tool.name === name)! };
};
/** Runs a fixed script against a fake app, the way osascript would. */
const script = (template: string, input: unknown, app: unknown) =>
  JSON.parse(runInNewContext(`${template}\nrun([${JSON.stringify(JSON.stringify(input))}])`, { Application: () => app, JSON, Path: (p: string) => p }));
const fn = <T>(value: T) => () => value;

describe("looking before acting", () => {
  it("doesn't open a closed Music just to pause it", () => {
    const opened: string[] = [];
    const closed = { running: fn(false), pause: () => opened.push("pause"), play: () => opened.push("play") };
    expect(script(MUSIC_CONTROL, { action: "pause" }, closed)).toEqual({ running: false });
    expect(opened).toEqual([]);
  });

  it("says so when Music is closed", async () => {
    const { get } = tools(vi.fn(async (): Promise<unknown> => ({ running: false })));
    expect(await get("music_control").run({ action: "next" }, ctx())).toMatch(/not open.*Nothing was changed/);
  });

  it("flags the same text to the same person on the card, as a likely retry", async () => {
    const { get } = tools(vi.fn(async (): Promise<unknown> => ({ handedOver: true, account: "me" })));
    const send = get("messages_send");
    const args = { to: "+905551234567", text: "Geliyorum" };
    expect(await send.preview!(args)).not.toMatch(/⚠/);
    await send.run(args, ctx());
    expect(await send.preview!(args)).toMatch(/⚠/);
    expect(await send.run(args, ctx())).toMatch(/same text went/);
  });
});

describe("everyday app scripts", () => {
  it("lists Chrome tabs without incognito windows, and Safari tabs by name", () => {
    const tab = (title: string) => ({ title: fn(title), name: fn(title), url: fn(`https://${title}.test/`) });
    const chrome = { running: fn(true), windows: fn([
      { mode: fn("incognito"), tabs: fn([tab("secret")]) },
      { mode: fn("normal"), tabs: fn([tab("news")]) },
    ]) };
    const out = script(BROWSER_TABS, { bundle: "com.google.Chrome", limit: 100 }, chrome);
    expect(out).toEqual({ running: true, skippedPrivate: 1, tabs: [{ window: 2, title: "news", url: "https://news.test/" }] });
    const safari = { running: fn(true), windows: fn([{ tabs: fn([tab("mail")]) }]) };
    expect(script(BROWSER_TABS, { bundle: "com.apple.Safari", limit: 100 }, safari).tabs[0].title).toBe("mail");
    expect(script(BROWSER_TABS, { bundle: "com.apple.Safari", limit: 100 }, { running: fn(false) })).toEqual({ running: false, tabs: [] });
  });

  it("opens a Chrome page in a normal window, never an incognito one", () => {
    const pushed: unknown[] = [];
    const normal = { mode: fn("normal"), tabs: Object.assign([], { push: (t: unknown) => pushed.push(t) }), activeTabIndex: 0 };
    const incognito = { mode: fn("incognito"), tabs: { push: () => { throw new Error("used incognito"); } } };
    const chrome = { windows: fn([incognito, normal]), Tab: (p: unknown) => p, activate: () => {} };
    script(BROWSER_OPEN, { bundle: "com.google.Chrome", url: "https://example.com/" }, chrome);
    expect(pushed).toEqual([{ url: "https://example.com/" }]);
  });

  it("sends a message only through an enabled account of the chosen service", () => {
    const sms = { enabled: fn(true), serviceType: fn("SMS") };
    const off = { enabled: fn(false), serviceType: fn("iMessage") };
    expect(script(MESSAGES_SEND, { to: "+905551234567", text: "hi", service: "iMessage" }, { accounts: fn([sms, off]) })).toEqual({ noAccount: true });
    const sent: unknown[] = [];
    const person = { handle: "+905551234567" };
    let asked: unknown;
    const account = { enabled: fn(true), serviceType: fn("iMessage"), description: fn("me@icloud.com"), participants: { byName: (handle: unknown) => { asked = handle; return person; } } };
    const app = { accounts: fn([sms, account]), send: (text: string, opts: { to: unknown }) => sent.push([text, opts.to]) };
    expect(script(MESSAGES_SEND, { to: "+905551234567", text: "hi", service: "iMessage" }, app)).toEqual({ handedOver: true, account: "me@icloud.com" });
    expect(asked).toBe("+905551234567");
    expect(sent).toEqual([["hi", person]]);
  });

  it("says which step failed, so a failure before sending is told apart from one while sending", () => {
    const account = { enabled: fn(true), serviceType: fn("iMessage"), description: fn("me"), participants: { byName: () => ({ handle: "x" }) } };
    const failing = { accounts: fn([account]), send: () => { throw Object.assign(new Error("Can't convert types."), { errorNumber: -1700 }); } };
    expect(script(MESSAGES_SEND, { to: "x", text: "hi", service: "iMessage" }, failing)).toEqual({ failed: "send", reason: "Can't convert types." });
    // One account Messages can't describe is passed over; all of them is a failure before sending.
    const broken = { enabled: fn(true), serviceType: () => { throw Object.assign(new Error("AppleEvent handler failed."), { errorNumber: -10000 }); } };
    const sent: unknown[] = [];
    expect(script(MESSAGES_SEND, { to: "x", text: "hi", service: "iMessage" }, { accounts: fn([broken, account]), send: () => sent.push(1) })).toEqual({ handedOver: true, account: "me" });
    expect(script(MESSAGES_SEND, { to: "x", text: "hi", service: "iMessage" }, { accounts: fn([broken]) })).toMatchObject({ failed: "account details" });
    const denied = { accounts: () => { throw Object.assign(new Error("Not authorised"), { errorNumber: -1743 }); } };
    expect(() => script(MESSAGES_SEND, { to: "x", text: "hi", service: "iMessage" }, denied)).toThrow(/Not authorised/);
  });

  it("tells a send that may have gone from one that surely didn't", async () => {
    const maybe = tools(vi.fn(async (): Promise<unknown> => ({ failed: "send", reason: "Can't convert types." })));
    await expect(maybe.get("messages_send").run({ to: "a@b.test", text: "hi" }, ctx())).rejects.toThrow(/bilinmiyor|unknown/);
    // Maybe sent: asking again shows it as a repeat.
    expect(await maybe.get("messages_send").preview!({ to: "a@b.test", text: "hi" })).toMatch(/⚠/);
    const before = tools(vi.fn(async (): Promise<unknown> => ({ failed: "recipient", reason: "Can't get participant." })));
    await expect(before.get("messages_send").run({ to: "a@b.test", text: "hi" }, ctx())).rejects.toThrow(/gönderilmedi|Nothing was sent/);
  });

  it("exports each small picture on its own, past one that fails, but not past a lost permission", () => {
    const exported: unknown[] = [];
    const exporting = (fail: (id: string) => Error | null) => ({
      mediaItems: { byId: (id: string) => id },
      export: (items: string[], opts: { to: string }) => {
        const error = fail(items[0]!);
        if (error) throw error;
        exported.push([items[0], opts.to]);
      },
    });
    const refused = (n: number) => Object.assign(new Error("no"), { errorNumber: n });
    script(PHOTOS_THUMBS, { ids: ["a", "b", "c"], folders: ["/t/1", "/t/2", "/t/3"] }, exporting((id) => (id === "b" ? refused(-1728) : null)));
    expect(exported).toEqual([["a", "/t/1"], ["c", "/t/3"]]);
    expect(() => script(PHOTOS_THUMBS, { ids: ["a"], folders: ["/t/1"] }, exporting(() => refused(-1743)))).toThrow();
  });

  it("returns only the chosen photo and contact fields, within the limit", () => {
    const item = (n: number) => ({ id: fn(`id${n}`), filename: fn(`IMG_${n}.HEIC`), name: fn(null), date: fn(new Date("2024-05-01T10:00:00Z")), favorite: fn(false), width: fn(4032), height: fn(3024), location: fn([41, 29]) });
    const photos = script(PHOTOS_SEARCH, { query: "dog", limit: 2 }, { search: () => [item(1), item(2), item(3)] });
    expect(photos.total).toBe(3);
    expect(photos.items).toHaveLength(2);
    expect(photos.items[0]).toEqual({ id: "id1", filename: "IMG_1.HEIC", name: "", date: "2024-05-01T10:00:00.000Z", favorite: false, width: 4032, height: 3024 });
    const person = { name: fn("Ayşe Test"), organization: fn(null), emails: { value: fn(["a@x.test", "b@x.test", "c@x.test", "d@x.test"]) }, phones: { value: fn([]) }, birthDate: fn("1990"), note: fn("private") };
    const people = script(CONTACTS_SEARCH, { query: "Ayşe", limit: 20 }, { people: { whose: () => fn([person]) } });
    expect(people.people).toEqual([{ name: "Ayşe Test", organization: "", emails: ["a@x.test", "b@x.test", "c@x.test"], phones: [] }]);
    // Asked for email only: the phone numbers aren't even read.
    const guarded = { ...person, phones: { value: () => { throw new Error("phones read"); } } };
    const emailOnly = script(CONTACTS_SEARCH, { query: "Ayşe", want: "email", limit: 10 }, { people: { whose: () => fn([guarded]) } });
    expect(emailOnly.people).toEqual([{ name: "Ayşe Test", organization: "", emails: ["a@x.test", "b@x.test", "c@x.test"] }]);
    const phoneOnly = script(CONTACTS_SEARCH, { query: "Ayşe", want: "phone", limit: 10 }, { people: { whose: () => fn([person]) } });
    expect(phoneOnly.people).toEqual([{ name: "Ayşe Test", organization: "", phones: [] }]);
  });

  it("does not open Music just to say nothing is playing", () => {
    expect(script(MUSIC_NOW, {}, { running: fn(false), playerState: () => { throw new Error("launched"); } })).toEqual({ running: false });
  });
});

describe("everyday app tools", () => {
  it("asks once for reads and every time for anything that plays, opens, exports or sends", () => {
    const { get } = tools();
    for (const name of ["music_now_playing", "photos_search", "browser_tabs", "contacts_search"]) {
      expect(get(name)).toMatchObject({ actionClass: "read", alwaysAsk: true, allowSessionApproval: true, untrustedOutput: true });
    }
    for (const name of ["music_control", "music_play", "photos_export", "browser_open_url"]) {
      expect(get(name)).toMatchObject({ actionClass: "write-local", alwaysAsk: true });
      expect(get(name).allowSessionApproval).toBeUndefined();
    }
    expect(get("messages_send")).toMatchObject({ actionClass: "outbound", alwaysAsk: true });
    expect(get("messages_send").allowSessionApproval).toBeUndefined();
  });

  it("opens only public http(s) pages in the user's browser", async () => {
    const { get, run } = tools();
    for (const url of ["file:///etc/passwd", "http://localhost:9333/json", "http://192.168.1.1/", "javascript:alert(1)", "about:blank", "https://u:p@x.test/"]) {
      await expect(get("browser_open_url").run({ browser: "Safari", url }, ctx())).rejects.toThrow();
    }
    await expect(get("browser_open_url").run({ browser: "Firefox", url: "https://x.test" }, ctx())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await get("browser_open_url").run({ browser: "Google Chrome", url: "https://example.com" }, ctx());
    expect(run.mock.calls[0]![1]).toMatchObject({ bundle: "com.google.Chrome", url: "https://example.com/" });
  });

  it("shows the recipient, service and whole text before sending, and refuses unclear recipients", async () => {
    const { get, run } = tools();
    const preview = await get("messages_send").preview!({ to: "+90 555 123 45 67", text: "Geliyorum", service: "SMS" });
    expect(preview).toContain("+90 555 123 45 67");
    expect(preview).toContain("Geliyorum");
    expect(preview).toContain("SMS");
    await expect(get("messages_send").run({ to: "Ali", text: "x" }, ctx())).rejects.toThrow();
    await expect(get("messages_send").run({ to: "+905551234567", text: " " }, ctx())).rejects.toThrow();
    await expect(get("messages_send").run({ to: "+905551234567", text: "x", service: "WhatsApp" }, ctx())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(recipient("+90 (555) 123-45-67")).toBe("+905551234567");
  });

  it("reads one contact detail at a time, never both at once", async () => {
    const { get, run } = tools(vi.fn(async (): Promise<unknown> => ({ total: 0 })));
    await expect(get("contacts_search").run({ query: "Ayşe", want: "both" }, ctx())).rejects.toThrow(/email" or "phone/);
    await expect(get("contacts_search").run({ query: "Ayşe" }, ctx())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await get("contacts_search").run({ query: "Ayşe", want: "email" }, ctx());
    expect((run.mock.calls[0]![1] as { want: string }).want).toBe("email");
  });

  it("says it handed a message over, not that it was delivered", async () => {
    const { get } = tools(vi.fn(async (): Promise<unknown> => ({ handedOver: true, account: "me" })));
    await expect(get("messages_send").run({ to: "a@b.test", text: "hi" }, ctx())).resolves.toMatch(/doesn't report delivery/);
  });

  it("exports photos into a new folder of their own and lists the files it made", async () => {
    const produced: Produced[] = [];
    const run = vi.fn(async (_template: unknown, input: unknown): Promise<unknown> => {
      writeFileSync(join((input as { folder: string }).folder, "IMG_1.jpeg"), "x");
      return { ok: true };
    });
    const { get } = tools(run);
    writeFileSync(join(allowed, "IMG_1.jpeg"), "keep me");
    const out = await get("photos_export").run({ ids: ["ABC/L0/001"], folder: allowed }, ctx(produced));
    const made = readdirSync(allowed).filter((name) => name.startsWith("Vunemi Photos "));
    expect(made).toHaveLength(1);
    expect(out).toContain(`- ${join(allowed, made[0]!, "IMG_1.jpeg")}`);
    expect(produced).toEqual([{ kind: "file", path: join(allowed, made[0]!, "IMG_1.jpeg") }]);
    await expect(get("photos_export").run({ ids: ["x"], folder: base }, ctx())).rejects.toThrow();
    await expect(get("photos_export").run({ ids: Array.from({ length: 11 }, (_, i) => `id${i}`), folder: allowed }, ctx())).rejects.toThrow();
    await expect(get("photos_export").run({ ids: ['x"; do shell script'], folder: allowed }, ctx())).rejects.toThrow();
  });

  it("names the export folder in the user's own time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 26, 22, 25, 1));
    try {
      const run = vi.fn(async (_template: unknown, input: unknown): Promise<unknown> => {
        writeFileSync(join((input as { folder: string }).folder, "IMG_2.jpeg"), "x");
        return { ok: true };
      });
      const { get } = tools(run);
      await get("photos_export").run({ ids: ["ABC/L0/002"], folder: allowed }, ctx());
      expect(readdirSync(allowed)).toContain("Vunemi Photos 2026-09-26 22.25.01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an unknown Music action before reaching Music", async () => {
    const { get, run } = tools();
    await expect(get("music_control").run({ action: "buy" }, ctx())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("pictures of found photos", () => {
  // A 2×2 red PNG: enough for sips to read and shrink.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

  it.skipIf(process.platform !== "darwin")("shows the person small pictures of the first stills, and tells the model only that", async () => {
    const thumbDir = join(base, "thumbs");
    const run = vi.fn(async (template: unknown, args: unknown): Promise<unknown> => {
      if (template === PHOTOS_SEARCH) {
        return { total: 3, items: [
          { id: "A/L0/001", filename: "IMG_0001.HEIC", date: "2024-05-01T10:00:00.000Z" },
          { id: "B/L0/001", filename: "IMG_0002.MOV", date: null },
          { id: "C/L0/001", filename: "IMG_0003.JPG", date: null },
          { id: "D/L0/001", filename: "IMG_0004.JPG", date: null },
        ] };
      }
      // An edited photo exports under another name; one that fails leaves its folder empty.
      const folders = (args as { folders: string[] }).folders;
      writeFileSync(join(folders[0]!, "FullSizeRender.jpeg"), PNG);
      writeFileSync(join(folders[1]!, "IMG_0003.jpeg"), PNG);
      return { ok: true };
    });
    const list = createEverydayTools(run, new Roots([allowed]), { thumbDir });
    const shown: { path: string; label?: string }[] = [];
    const context = { signal: new AbortController().signal, gallery: (items: { path: string; label?: string }[]) => shown.push(...items) } as unknown as ToolContext;
    const out = await list.find((tool) => tool.name === "photos_search")!.run({ query: "dog" }, context);
    expect(shown.map((item) => item.label)).toEqual(["IMG_0001.HEIC · 2024-05-01", "IMG_0003.JPG"]);
    expect(shown.every((item) => item.path.startsWith(thumbDir) && item.path.endsWith(".png"))).toBe(true);
    expect((run.mock.calls[1]![1] as { ids: string[] }).ids).toEqual(["A/L0/001", "C/L0/001", "D/L0/001"]);
    expect(out).toContain("The user sees small pictures of the first 2");
    // Only the small copies stay.
    const folder = readdirSync(thumbDir)[0]!;
    expect(readdirSync(join(thumbDir, folder)).sort()).toEqual(["1.png", "2.png"]);
  });

  it("still answers when no picture can be made", async () => {
    const run = vi.fn(async (template: unknown): Promise<unknown> => {
      if (template === PHOTOS_SEARCH) return { total: 1, items: [{ id: "A", filename: "IMG_0001.JPG", date: null }] };
      throw new Error("Photos said no");
    });
    const list = createEverydayTools(run, new Roots([allowed]), { thumbDir: join(base, "thumbs-fail") });
    const context = { signal: new AbortController().signal, gallery: vi.fn() } as unknown as ToolContext;
    const out = await list.find((tool) => tool.name === "photos_search")!.run({ query: "dog" }, context);
    expect(out).toContain("IMG_0001.JPG");
    expect(out).not.toContain("small pictures");
  });
});
