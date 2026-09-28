/**
 * Search by meaning with the real model: VUNEMI_LIVE_EMBED is a folder
 * holding the pinned Qwen3-Embedding file, and VUNEMI_LIVE_ENGINE the
 * llama-server to run it with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/main/memory/store.js";
import { Embedder } from "../../src/main/memory/embedder.js";
import { recall } from "../../src/main/memory/recall.js";

const modelDir = process.env.VUNEMI_LIVE_EMBED;
const binary = process.env.VUNEMI_LIVE_ENGINE ?? null;

describe.skipIf(!modelDir || !binary)("meaning search, live", () => {
  let dir = "";
  let store: MemoryStore;
  let embedder: Embedder;
  const notes = [
    "Raporları PDF olarak isterim", "Müdürüm Ayşe Kaya", "Arabam Salı günü serviste", "Kedim Pamuk tahıllı mama yiyemiyor",
    "Kadıköy'deki evin çatısı akıtıyor", "My dentist appointment is every March", "Kardeşim Deniz İzmir'de yaşıyor",
    "Sabah 9'dan önce toplantı koyma", "Fıstık alerjim var", "I prefer metric units",
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vunemi-live-embed-"));
    store = new MemoryStore(dir);
    embedder = new Embedder({ binary, dir: modelDir! });
    for (const text of notes) await store.add({ text, kind: "topic", evidence: { quote: text, sessionId: null, at: 1 } });
  }, 60_000);
  afterAll(async () => {
    await embedder.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const about = async (request: string) => (await recall(store, embedder, request)).topic;

  it("finds notes that share no word with the request", async () => {
    expect(await about("Book a check-up with my dentist")).toContain("My dentist appointment is every March");
    expect(await about("Convert this recipe's measurements")).toContain("I prefer metric units");
    expect(await about("Yarın için bir toplantı ayarla")).toContain("Sabah 9'dan önce toplantı koyma");
  }, 60_000);

  it("gives little to an unrelated request", async () => {
    // Stray notes happen: "topla" shares its stem with "toplantı", and a sum
    // is close enough to units for the model. Two short notes at most.
    for (const request of ["2 ile 3'ü topla", "Python'da liste nasıl sıralanır?", "Bir fıkra anlat"]) {
      expect((await about(request)).length).toBeLessThanOrEqual(2);
    }
  }, 60_000);
});
