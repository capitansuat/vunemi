/**
 * Search by meaning in topics: notes and sources cut in parts, each part
 * embedded when Vunemi is idle, a search fusing words and meaning.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partsOf, PART_CHARS, TopicStore } from "../../src/main/topics/store.js";
import { combined, PART_MIN, tendAgainIn, TopicMeaning } from "../../src/main/topics/meaning.js";
import { TooLongError } from "../../src/main/memory/embedder.js";

describe("cutting a text in parts", () => {
  it("keeps short paragraphs together, and says where each part starts", () => {
    const text = "First paragraph.\n\nSecond one.";
    expect(partsOf(text)).toEqual([{ start: 0, text }]);
    const long = `${"a".repeat(600)}\n\n${"b".repeat(600)}`;
    expect(partsOf(long)).toEqual([
      { start: 0, text: "a".repeat(600) },
      { start: 602, text: "b".repeat(600) },
    ]);
  });

  it("cuts a long paragraph by lines, and a long line by length", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i} ${"x".repeat(60)}`).join("\n");
    const parts = partsOf(lines);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(PART_CHARS);
      expect(lines.slice(part.start, part.start + part.text.length)).toBe(part.text);
    }
    expect(partsOf("y".repeat(PART_CHARS * 2 + 5)).map((p) => [p.start, p.text.length])).toEqual([[0, PART_CHARS], [PART_CHARS, PART_CHARS], [PART_CHARS * 2, 5]]);
  });

  it("gives each part of a long table its header", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| Tile ${i} | ${400 + i} TL | Kale |`);
    const table = ["| Item | Price | Maker |", "| --- | --- | --- |", ...rows].join("\n");
    const parts = partsOf(table);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.text.startsWith("| Item | Price | Maker |\n| --- | --- | --- |\n|")).toBe(true);
    expect(parts[0]!.start).toBe(0);
    expect(table.slice(parts[1]!.start)).toMatch(/^\| Tile \d+ \|/);
  });
});

/** A stand-in embedder: a direction per word it knows; unknown words point nowhere. */
const WORDS = ["tile", "plumber", "budget"];
const SAME = { tile: ["tile", "seramik", "porcelain"], plumber: ["plumber", "tesisatçı", "leak"], budget: ["budget", "money", "bütçe"] } as Record<string, string[]>;
function embedder(available = true) {
  const passages: string[] = [];
  return {
    passages,
    meaning: {
      available: () => available,
      embed: async (texts: string[], as: "query" | "passage") => {
        if (as === "passage") passages.push(...texts);
        return texts.map((text) => {
          const lower = text.toLowerCase();
          const v = WORDS.map((w) => (SAME[w]!.some((s) => lower.includes(s)) ? 1 : 0));
          const norm = Math.hypot(...v) || 1;
          return Float32Array.from([...v.map((x) => x / norm), v.some(Boolean) ? 0 : 1]);
        });
      },
    },
  };
}

let base: string;
let store: TopicStore;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-topic-meaning-"));
  store = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data") });
  store.createTopic("Home renovation", "");
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("searching a topic by meaning", () => {
  it("finds a source by what it means, not its words, and says where in it", async () => {
    const filler = "Delivery terms and payment schedule.\n\n".repeat(40);
    store.addSource("Home renovation", { original: "/a/offer.pdf", markdown: `${filler}Seramik 60×60, mat yüzey, m² başına 480 TL.`, bytes: 1, sha256: "a".repeat(64) });
    store.writeNote("Home renovation", { title: "Kerem", text: "Tesisatçı, salı günleri gelir.", by: "vunemi", sources: [] });
    const { meaning } = embedder();
    const found = await new TopicMeaning(store, meaning).find("which tile did we pick", "Home renovation", 10);
    expect(found.byMeaning).toBe(true);
    expect(found.pending).toBe(0);
    expect(found.hits[0]).toMatchObject({ kind: "source", title: "offer" });
    expect(found.hits[0]!.snippet).toContain("Seramik 60×60");
    const text = store.readSource("Home renovation", "offer")!.text;
    expect(text.slice(found.hits[0]!.at!)).toMatch(/^.*Seramik/s);
    expect(found.hits.map((h) => h.title)).not.toContain("Kerem");
  });

  it("finds by words alone without the meaning model", async () => {
    store.writeNote("Home renovation", { title: "Budget", text: "Total 180,000", by: "vunemi", sources: [] });
    const { meaning, passages } = embedder(false);
    const found = await new TopicMeaning(store, meaning).find("180,000", "Home renovation", 10);
    expect(found).toMatchObject({ byMeaning: false, pending: 0 });
    expect(found.hits.map((h) => h.title)).toEqual(["Budget"]);
    expect(passages).toEqual([]);
  });

  it("embeds parts when idle, once, and again only what changed", async () => {
    const { note } = store.writeNote("Home renovation", { title: "Budget", text: "Money for the bathroom", by: "vunemi", sources: [] });
    store.writeNote("Home renovation", { title: "Plumber", text: "Kerem fixes the leak", by: "vunemi", sources: [] });
    const { meaning, passages } = embedder();
    const topicMeaning = new TopicMeaning(store, meaning);
    expect(await topicMeaning.catchUp()).toBe("done");
    expect(passages.sort()).toEqual(["Budget\nMoney for the bathroom", "Plumber\nKerem fixes the leak"]);
    await topicMeaning.catchUp();
    expect(passages).toHaveLength(2);
    writeFileSync(note.path, "---\ntitle: \"Budget\"\n---\n\nMoney for the kitchen");
    const later = new Date(Date.now() + 5_000);
    utimesSync(note.path, later, later);
    await topicMeaning.catchUp();
    expect(passages.at(-1)).toBe("Budget\nMoney for the kitchen");
    expect(passages).toHaveLength(3);
  });

  it("stops embedding when Vunemi is busy, and counts what waits", async () => {
    for (let i = 0; i < 40; i++) store.writeNote("Home renovation", { title: `Note ${i}`, text: `budget line ${i}`, by: "vunemi", sources: [] });
    const { meaning, passages } = embedder();
    let calls = 0;
    expect(await new TopicMeaning(store, meaning).catchUp(() => calls++ < 1)).toBe("paused");
    expect(passages).toHaveLength(16);
    expect(store.pendingParts("qwen3-embedding-0.6b-q8_0", "Home renovation")).toBe(24);
  });

  it("embeds the start of a part too long for the model, and goes on with the rest", async () => {
    for (let i = 0; i < 3; i++) store.writeNote("Home renovation", { title: `Note ${i}`, text: `budget line ${i}`, by: "vunemi", sources: [] });
    store.writeNote("Home renovation", { title: "Prices", text: "9".repeat(900), by: "vunemi", sources: [] });
    const { meaning, passages } = embedder();
    const asked: number[] = [];
    const strict = {
      available: meaning.available,
      embed: async (texts: string[], as: "query" | "passage") => {
        asked.push(texts.length);
        if (texts.some((t) => t.length > 500)) throw new TooLongError("too long");
        return meaning.embed(texts, as);
      },
    };
    await new TopicMeaning(store, strict).catchUp();
    expect(store.pendingParts("qwen3-embedding-0.6b-q8_0", "Home renovation")).toBe(0);
    const prices = passages.find((p) => p.startsWith("Prices\n"))!;
    expect(prices.length).toBeLessThanOrEqual(500);
    expect(asked[0]).toBe(4);
  });

  it("stops at once when the model itself fails, not part by part", async () => {
    for (let i = 0; i < 3; i++) store.writeNote("Home renovation", { title: `Note ${i}`, text: `budget line ${i}`, by: "vunemi", sources: [] });
    let calls = 0;
    const down = { available: () => true, embed: async () => { calls++; throw new Error("The meaning model answered 500."); } };
    expect(await new TopicMeaning(store, down).catchUp()).toBe("failed");
    expect(calls).toBe(1);
    expect(store.pendingParts("qwen3-embedding-0.6b-q8_0", "Home renovation")).toBe(3);
  });

  it("tries a failed pass again later, waiting longer each time, at most half an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => tendAgainIn("failed", n)! / 60_000)).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it("combines a folder pass and a meaning pass into one next look", () => {
    expect(combined("done", "done")).toBe("done");
    expect(combined("paused", "done")).toBe("paused");
    expect(combined("done", "failed")).toBe("failed");
    expect(combined("failed", "paused")).toBe("failed");
  });

  it("looks again in a minute while Vunemi is busy or a pass stepped aside, and stops when nothing is left", () => {
    expect(tendAgainIn("busy", 0)).toBe(60_000);
    expect(tendAgainIn("paused", 3)).toBe(60_000);
    expect(tendAgainIn("done", 3)).toBeNull();
  });

  it("leaves out what isn't about the query at all", async () => {
    store.writeNote("Home renovation", { title: "Weather", text: "Sunny on Tuesday", by: "vunemi", sources: [] });
    const found = await new TopicMeaning(store, embedder().meaning).find("plumber", "Home renovation", 10);
    expect(PART_MIN).toBeGreaterThan(0);
    expect(found.hits).toEqual([]);
  });
});
