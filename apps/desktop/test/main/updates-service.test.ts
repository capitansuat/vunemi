import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PRODUCTION } from "../../src/main/updates/feed.js";
import { DAY, UpdateService, type Updater } from "../../src/main/updates/service.js";
import type { UpdateStatus } from "../../src/shared/ipc.js";

const FEED = { currentRelease: "0.1.9", releases: [{ version: "0.1.9", updateTo: { version: "0.1.9", url: PRODUCTION.zip("0.1.9") } }], sizeMb: 131, notes: { en: ["New."] } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(over: { feed?: () => Promise<unknown>; idle?: boolean; installable?: boolean; enabled?: boolean; staged?: boolean | null; downloadPage?: string } = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const emitter = new EventEmitter();
  const updater: Updater = {
    setFeedURL: (o) => calls.push(`feed ${o.url}`),
    checkForUpdates: () => calls.push("download"),
    quitAndInstall: () => calls.push("install"),
    on: (event: string, fn: (...args: never[]) => void) => {
      emitter.on(event, fn as (...args: unknown[]) => void);
    },
  };
  const seen: UpdateStatus[] = [];
  const fetched: string[] = [];
  const s = new UpdateService({
    current: "0.1.8",
    locale: () => "en",
    source: PRODUCTION,
    fetchFeed: async (url) => {
      fetched.push(url);
      return (over.feed ?? (async () => FEED))();
    },
    updater,
    enabled: () => over.enabled ?? true,
    installable: () => over.installable ?? true,
    idle: () => over.idle ?? true,
    stagedMatches: async () => (over.staged === undefined ? true : over.staged),
    now: () => now,
    onChange: (st) => seen.push(st),
    ...(over.downloadPage && { downloadPage: over.downloadPage }),
  });
  return { s, calls, emitter, seen, fetched, advance: (ms: number) => { now += ms; } };
}

describe("UpdateService", () => {
  it("offers a newer version and downloads only when asked", async () => {
    const { s, calls, seen } = setup();
    expect((await s.check(false)).phase).toBe("available");
    expect(s.status().offer).toEqual({ version: "0.1.9", notes: ["New."], sizeMb: 131 });
    expect(calls).toEqual([]);
    expect(s.download().phase).toBe("downloading");
    expect(calls).toEqual([`feed ${PRODUCTION.feed}`, "download"]);
    expect(seen.at(-1)?.phase).toBe("downloading");
  });

  it("hands the offer to an updater that downloads it itself (Windows) before it starts", async () => {
    const { s, calls } = setup();
    const prepared: unknown[] = [];
    (s as unknown as { deps: { updater: Updater } }).deps.updater.prepare = (offer) => {
      prepared.push(offer);
      calls.push("prepare");
    };
    await s.check(false);
    s.download();
    expect(prepared).toEqual([{ version: "0.1.9", notes: ["New."], sizeMb: 131 }]);
    expect(calls).toEqual(["prepare", `feed ${PRODUCTION.feed}`, "download"]);
  });

  it("says up to date only after a manual check, and keeps quiet about failures otherwise", async () => {
    const same = setup({ feed: async () => ({ ...FEED, currentRelease: "0.1.8" }) });
    expect((await same.s.check(false)).phase).toBe("idle");
    expect((await same.s.check(true)).phase).toBe("current");
    const down = setup({ feed: async () => { throw new Error("offline"); } });
    expect((await down.s.check(false)).phase).toBe("idle");
    expect(await down.s.check(true)).toMatchObject({ phase: "failed", error: "network" });
  });

  it("tells a feed it cannot use from no feed at all", async () => {
    const { s } = setup({ feed: async () => ({ currentRelease: "0.1.9", releases: [] }) });
    expect(await s.check(true)).toMatchObject({ phase: "failed", error: "feed" });
  });

  it("checks a day apart, and not at all when turned off", async () => {
    const on = setup();
    on.s.tick();
    on.s.tick();
    await settle();
    expect(on.fetched).toHaveLength(1);
    on.s.tick();
    await settle();
    expect(on.fetched).toHaveLength(1);
    on.advance(DAY);
    on.s.tick();
    await settle();
    expect(on.fetched).toHaveLength(2);
    const off = setup({ enabled: false });
    off.s.tick();
    expect(off.fetched).toHaveLength(0);
  });

  it("tells a copy that can't replace itself where to download it (a .deb on Linux)", async () => {
    const page = "https://github.com/capitansuat/vunemi/releases";
    const { s, calls } = setup({ installable: false, downloadPage: page });
    await s.check(false);
    expect(s.status()).toMatchObject({ phase: "available", installable: false, downloadPage: page });
    expect(s.download().phase).toBe("available");
    expect(calls).toEqual([]);
    expect(setup().s.status().downloadPage).toBeUndefined();
  });

  it("does not download outside Applications", async () => {
    const { s, calls } = setup({ installable: false });
    await s.check(false);
    expect(s.download().phase).toBe("available");
    expect(calls).toEqual([]);
  });

  it("restarts only when idle and when the staged app is signed like this one", async () => {
    const busy = setup({ idle: false });
    await busy.s.check(false);
    busy.s.download();
    busy.emitter.emit("update-downloaded");
    expect(busy.s.status().phase).toBe("ready");
    expect((await busy.s.install()).phase).toBe("ready");
    expect(busy.calls).not.toContain("install");

    const bad = setup({ staged: false });
    await bad.s.check(false);
    bad.s.download();
    bad.emitter.emit("update-downloaded");
    expect(await bad.s.install()).toMatchObject({ phase: "failed", error: "signature" });
    expect(bad.calls).not.toContain("install");

    const unknown = setup({ staged: null });
    await unknown.s.check(false);
    unknown.s.download();
    unknown.emitter.emit("update-downloaded");
    await unknown.s.install();
    expect(unknown.calls).toContain("install");
  });

  it("names a signature refusal from Squirrel as such, and anything else a download failure", async () => {
    for (const [message, error] of [["Code signature at URL file:///x did not pass validation", "signature"], ["The network connection was lost.", "download"]] as const) {
      const { s, emitter } = setup();
      await s.check(false);
      s.download();
      emitter.emit("error", new Error(message));
      expect(s.status()).toMatchObject({ phase: "failed", error });
    }
  });
});
