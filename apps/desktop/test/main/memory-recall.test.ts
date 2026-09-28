import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, type NoteKind } from "../../src/main/memory/store.js";
import { fuse, generalInstructions, MEMORY_RULE, recall, standOut, type Meaning } from "../../src/main/memory/recall.js";

let dir = "";
let store: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-recall-"));
  store = new MemoryStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (text: string, kind: NoteKind = "topic") => store.add({ text, kind, evidence: { quote: text, sessionId: null, at: 1 } });

/** Meaning by topic: texts sharing a listed theme point the same way. */
function meaning(themes: Record<string, string[]>, fail = false): Meaning & { calls: string[][] } {
  const names = Object.keys(themes);
  const calls: string[][] = [];
  return {
    calls,
    available: () => true,
    embed: async (texts) => {
      calls.push(texts);
      if (fail) throw new Error("down");
      return texts.map((text) => {
        const v = new Float32Array(names.length + 1);
        names.forEach((name, i) => { if (themes[name]!.some((w) => text.toLowerCase().includes(w))) v[i] = 1; });
        if (!v.some(Boolean)) v[names.length] = 1;
        const length = Math.hypot(...v);
        return v.map((x) => x / length);
      });
    },
  };
}

describe("fuse", () => {
  it("ranks what both lists agree on first", () => {
    const fused = fuse([[{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "b" }, { id: "d" }]]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "d", "c"]);
  });
});

describe("standOut", () => {
  const hits = (...scores: number[]) => scores.map((score, i) => ({ id: `n${i}`, score }));

  it("keeps at most two notes well above the rest and near the best", () => {
    expect(standOut(hits(0.62, 0.3, 0.31, 0.29, 0.61, 0.33, 0.28)).map((h) => h.id)).toEqual(["n0", "n4"]);
    expect(standOut(hits(0.62, 0.3, 0.31, 0.29, 0.55, 0.33, 0.28)).map((h) => h.id)).toEqual(["n0"]);
  });

  it("gives nothing when no note stands out", () => {
    expect(standOut(hits(0.36, 0.3, 0.31, 0.29, 0.33, 0.28))).toEqual([]);
  });

  it("uses a fixed line while memory is small", () => {
    expect(standOut(hits(0.5, 0.2)).map((h) => h.id)).toEqual(["n0"]);
    expect(standOut(hits(0.4, 0.2))).toEqual([]);
  });
});

describe("recall", () => {
  it("gives nothing when memory is empty", async () => {
    expect(await recall(store, null, "anything")).toEqual({ notes: [], topic: [] });
    expect(generalInstructions(store)).toBe("");
  });

  it("gives general notes always and topic notes only when they fit", async () => {
    const brief = await add("Reply briefly", "general");
    const ayse = await add("My manager is Ayşe");
    await add("The flat in Kadıköy has a leak");
    const got = await recall(store, null, "Ayşe'ye bir mail yaz");
    expect(got.notes.map((n) => n.id).sort()).toEqual([brief.id, ayse.id].sort());
    expect(got.topic).toEqual(["My manager is Ayşe"]);
    expect(generalInstructions(store)).toBe(`${MEMORY_RULE}\n- Reply briefly`);
    expect(store.get(ayse.id)!.givenAt).not.toBeNull();
  });

  it("gives at most five general and five topic notes", async () => {
    for (let i = 0; i < 8; i++) await add(`General ${i}`, "general");
    for (let i = 0; i < 8; i++) await add(`Report detail ${i}`);
    const got = await recall(store, null, "report");
    expect(got.notes.filter((n) => n.kind === "general")).toHaveLength(5);
    expect(got.notes.filter((n) => n.kind === "topic")).toHaveLength(5);
  });

  it("finds a note by meaning when no word is shared, and fills in missing vectors", async () => {
    const car = await add("Araba servisi Salı günü");
    await add("Kedi maması bitti");
    const m = meaning({ car: ["araba", "otomobil", "car"], cat: ["kedi"] });
    const got = await recall(store, m, "otomobil ne zaman hazır?");
    expect(got.notes.map((n) => n.id)).toEqual([car.id]);
    expect(m.calls[0]).toHaveLength(2); // both notes, embedded once
    await recall(store, m, "car");
    expect(m.calls.slice(1).every((texts) => texts.length === 1)).toBe(true); // only the query now
  });

  it("falls back to keywords when the meaning model fails", async () => {
    const car = await add("Araba servisi Salı günü");
    const got = await recall(store, meaning({}, true), "araba");
    expect(got.notes.map((n) => n.id)).toEqual([car.id]);
  });
});
