import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResidentId } from "../../src/shared/ipc.js";
import { candidates, ModelManager } from "../../src/main/models/manager.js";
import type { MemoryReader } from "../../src/main/models/memory.js";

const GB = 1024 ** 3;
let mem: { available: number | null; footprint: number | null; pressure: number | null };
const reader: MemoryReader = {
  available: async () => mem.available,
  footprint: async () => mem.footprint,
  pressure: vi.fn(async () => mem.pressure),
};

beforeEach(() => {
  mem = { available: 20 * GB, footprint: GB, pressure: 1 };
  vi.mocked(reader.pressure).mockClear();
});

/** A server that gives `frees` bytes back to macOS when unloaded. */
function resident(id: ResidentId, over: { busy?: boolean; loaded?: boolean; frees?: number; mapped?: number } = {}) {
  const r = {
    id,
    working: over.busy ?? false,
    loaded: over.loaded ?? true,
    unloads: 0,
    busy: () => r.working,
    pid: () => (r.loaded ? 100 : null),
    mapped: () => over.mapped ?? 0,
    unload: async () => {
      r.unloads++;
      r.loaded = false;
      if (mem.available !== null) mem.available += over.frees ?? 0;
    },
  };
  return r;
}

function manager(...residents: ReturnType<typeof resident>[]): ModelManager {
  const m = new ModelManager({ reader, totalMemory: 64 * GB, now: () => 1_000 });
  for (const r of residents) m.register(r);
  return m;
}

// 65,536 → 16.1 GB; 32,768 → 13.1 GB; 16,384 → 11.5 GB; 8,192 → 10.8 GB.
const need = (context: number) => 10 * GB + context * 100_000;

describe("the contexts a launch tries", () => {
  it("halves down to 8,192 and never below", () => {
    expect(candidates(65_536)).toEqual([65_536, 32_768, 16_384, 8_192]);
    expect(candidates(40_000)).toEqual([40_000, 20_000, 10_000, 8_192]);
    expect(candidates(8_192)).toEqual([8_192]);
    expect(candidates(4_096)).toEqual([4_096]);
  });
});

describe("making room for the chat model", () => {
  it("opens with the wanted context when it fits, touching nothing", async () => {
    const meaning = resident("meaning");
    const m = manager(meaning);
    expect(await m.fit({ wanted: 65_536, need })).toEqual({ context: 65_536, tight: false });
    expect(meaning.unloads).toBe(0);
    expect((await m.view()).last).toBeNull();
  });

  it("unloads the idle helpers first, meaning model then whisper", async () => {
    mem.available = 15 * GB;
    const meaning = resident("meaning", { frees: GB });
    const voice = resident("voice", { frees: GB });
    const chat = resident("chat");
    const m = manager(meaning, voice, chat);
    expect(await m.fit({ wanted: 65_536, need })).toEqual({ context: 65_536, tight: false });
    expect([meaning.unloads, voice.unloads, chat.unloads]).toEqual([1, 1, 0]);
    expect((await m.view()).last).toEqual({ at: 1_000, kind: "unloaded", ids: ["meaning", "voice"] });
  });

  it("never unloads a busy helper, and lowers the context to the first that fits", async () => {
    mem.available = 12 * GB;
    const meaning = resident("meaning", { frees: 0.6 * GB });
    const voice = resident("voice", { busy: true, frees: GB });
    const m = manager(meaning, voice);
    expect(await m.fit({ wanted: 65_536, need })).toEqual({ context: 16_384, tight: false });
    expect(voice.unloads).toBe(0);
    expect((await m.view()).last).toEqual({ at: 1_000, kind: "lowered", context: 16_384, wanted: 65_536 });
  });

  it("opens with 8,192 and says it is tight when nothing fits", async () => {
    mem.available = 5 * GB;
    const m = manager();
    expect(await m.fit({ wanted: 65_536, need })).toEqual({ context: 8_192, tight: true });
    expect((await m.view()).last).toMatchObject({ kind: "lowered", context: 8_192 });
  });

  it("counts the chat model a launch replaces as memory coming back, without stopping it itself", async () => {
    mem.available = 7 * GB;
    const chat = resident("chat", { mapped: 9 * GB });
    const m = manager(chat);
    // 7 GB available + 1 GB footprint + 9 GB mapped file.
    expect(await m.fit({ wanted: 65_536, need, replacing: "chat" })).toEqual({ context: 65_536, tight: false });
    expect(chat.unloads).toBe(0);
  });

  it("opens as before when memory cannot be measured", async () => {
    mem.available = null;
    const meaning = resident("meaning");
    expect(await manager(meaning).fit({ wanted: 65_536, need })).toEqual({ context: 65_536, tight: false });
    expect(meaning.unloads).toBe(0);
  });
});

describe("the pressure watcher", () => {
  it("does not even ask while no model is loaded", async () => {
    await manager(resident("chat", { loaded: false })).tick();
    expect(reader.pressure).not.toHaveBeenCalled();
  });

  it("on a warning unloads idle helpers, and the idle chat model only if the warning stays", async () => {
    mem.pressure = 2;
    const meaning = resident("meaning");
    const chat = resident("chat");
    const m = manager(meaning, chat);
    await m.tick();
    expect([meaning.unloads, chat.unloads]).toEqual([1, 0]);
    await m.tick();
    expect(chat.unloads).toBe(1);
  });

  it("starts counting again once the warning is gone", async () => {
    const chat = resident("chat");
    const m = manager(chat);
    mem.pressure = 2;
    await m.tick();
    mem.pressure = 1;
    await m.tick();
    mem.pressure = 2;
    await m.tick();
    expect(chat.unloads).toBe(0);
  });

  it("on critical unloads everything idle at once, and never a busy server", async () => {
    mem.pressure = 4;
    const meaning = resident("meaning");
    const voice = resident("voice", { busy: true });
    const chat = resident("chat");
    const m = manager(meaning, voice, chat);
    await m.tick();
    expect([meaning.unloads, voice.unloads, chat.unloads]).toEqual([1, 0, 1]);
    expect((await m.view()).last).toEqual({ at: 1_000, kind: "unloaded", ids: ["meaning", "chat"] });
  });

  it("does nothing when the level cannot be read", async () => {
    mem.pressure = null;
    const meaning = resident("meaning");
    await manager(meaning).tick();
    expect(meaning.unloads).toBe(0);
  });
});

describe("what the models page shows", () => {
  it("lists every server in unload order with its footprint plus the file it maps", async () => {
    mem.available = 30 * GB;
    const m = manager(resident("chat", { mapped: 20 * GB }), resident("meaning", { loaded: false }));
    expect(await m.view()).toEqual({
      total: 64 * GB,
      available: 30 * GB,
      residents: [
        { id: "meaning", loaded: false, bytes: null },
        { id: "voice", loaded: false, bytes: null },
        { id: "chat", loaded: true, bytes: 21 * GB },
      ],
      last: null,
    });
  });

  it("says a loaded server could not be measured rather than guess", async () => {
    mem.footprint = null;
    const view = await manager(resident("chat", { mapped: 20 * GB })).view();
    expect(view.residents.at(-1)).toEqual({ id: "chat", loaded: true, bytes: null });
  });
});
