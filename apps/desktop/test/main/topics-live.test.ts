/**
 * Topics by meaning with the real model (as memory-live.test.ts):
 * VUNEMI_LIVE_EMBED is a folder holding the pinned Qwen3-Embedding file,
 * VUNEMI_LIVE_ENGINE the llama-server to run it with. Prints the scores the
 * thresholds in suggest.ts and meaning.ts were chosen on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cosine, Embedder } from "../../src/main/memory/embedder.js";
import { suggestTopic, topicText } from "../../src/main/topics/suggest.js";
import { TopicStore } from "../../src/main/topics/store.js";
import { TopicMeaning } from "../../src/main/topics/meaning.js";

const modelDir = process.env.VUNEMI_LIVE_EMBED;
const binary = process.env.VUNEMI_LIVE_ENGINE ?? null;

const TOPICS = [
  { name: "Ev tadilatı", about: "Banyo ve mutfak tadilatı: ustalardan gelen teklifler, seramik ve dolap seçimi, bütçe." },
  { name: "Vergi 2026", about: "2026 yılı gelir vergisi beyannamesi, kira geliri, makbuzlar ve son tarihler." },
  { name: "Thesis research", about: "PhD thesis on urban heat islands: papers, datasets and the methods chapter." },
  { name: "Kedi Pamuk", about: "Kedim Pamuk'un sağlığı, veteriner randevuları, aşıları ve maması." },
];
const FITS: [string, string][] = [
  ["Ustanın gönderdiği iki teklifi karşılaştırır mısın?", "Ev tadilatı"],
  ["Mutfak dolapları için hangi rengi seçmiştik?", "Ev tadilatı"],
  ["Kira gelirimi nasıl beyan edeceğim?", "Vergi 2026"],
  ["Summarise the Landsat dataset section for chapter 3", "Thesis research"],
  ["Pamuk'un karma aşısı ne zaman?", "Kedi Pamuk"],
  ["Which papers measured surface temperature in Istanbul?", "Thesis research"],
];
const NONE = ["Yarın hava nasıl olacak?", "Write a haiku about autumn", "Bugün akşam ne pişireyim?", "Saat kaç?"];

describe.skipIf(!modelDir || !binary)("topics by meaning, live", () => {
  let dir = "";
  let embedder: Embedder;
  let store: TopicStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vunemi-live-topics-"));
    embedder = new Embedder({ binary, dir: modelDir! });
    store = new TopicStore({ root: () => join(dir, "Memory"), dataDir: join(dir, "data") });
  });
  afterAll(async () => {
    await embedder.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks about the topic a request fits, and about none for a request that fits none", async () => {
    const cache = new Map<string, Float32Array>();
    const vectors = await embedder.embed(TOPICS.map(topicText), "passage");
    const rows: string[] = [];
    for (const [request] of [...FITS, ...NONE.map((r) => [r, null] as const)]) {
      const [q] = await embedder.embed([request], "query", "Given a request to an assistant, retrieve the description of the subject the request belongs to");
      rows.push(`${request}: ${TOPICS.map((t, i) => `${t.name}=${cosine(q!, vectors[i]!).toFixed(3)}`).join(" ")}`);
    }
    console.log(rows.join("\n"));
    for (const [request, topic] of FITS) expect(await suggestTopic(embedder, request, TOPICS, cache), request).toBe(topic);
    for (const request of NONE) expect(await suggestTopic(embedder, request, TOPICS, cache), request).toBeNull();
  }, 180_000);

  it("finds the part of a source a question is about, by meaning", async () => {
    store.createTopic("Ev tadilatı", TOPICS[0]!.about);
    const filler = Array.from({ length: 30 }, (_, i) => `Madde ${i + 1}: Teslimat, nakliye ve ödeme koşulları sözleşmenin ekinde belirtilmiştir.`).join("\n\n");
    store.addSource("Ev tadilatı", {
      original: "/a/teklif-kale.pdf",
      markdown: `${filler}\n\n| Ürün | Birim fiyat | Marka |\n| --- | --- | --- |\n| 60×60 mat porselen yer karosu | 480 TL/m² | Kale |\n| Duvar fayansı 30×60 | 390 TL/m² | Kale |`,
      bytes: 1,
      sha256: "a".repeat(64),
    });
    store.writeNote("Ev tadilatı", { title: "Tesisatçı", text: "Kerem usta salı günleri gelebiliyor; su kaçağı için 3.000 TL istedi.", by: "vunemi", sources: [] });
    store.writeNote("Ev tadilatı", { title: "Bütçe", text: "Toplam tavan 180.000 TL; mutfak 100.000, banyo 80.000.", by: "vunemi", sources: [] });
    const meaning = new TopicMeaning(store, embedder);
    await meaning.catchUp();
    const questions = [["zemin için seçtiğimiz seramiğin metrekare fiyatı", "teklif-kale"], ["who fixes the leak and when can he come", "Tesisatçı"], ["ne kadar harcayabiliriz", "Bütçe"], ["kedinin aşı takvimi", null], ["write a poem about the sea", null]] as const;
    for (const [query] of questions) {
      const [q] = await embedder.embed([query], "query", "Given a question, retrieve passages from the user's notes and documents that answer it");
      console.log(query, "scores:", store.nearestParts(q!, "qwen3-embedding-0.6b-q8_0", "Ev tadilatı", 10).map((h) => `${h.title}=${h.score.toFixed(3)}`).join(" "));
    }
    // The answer among the first three, the clear ones first; a poem finds nothing.
    const first = async (query: string) => (await meaning.find(query, "Ev tadilatı", 5)).hits.map((h) => h.title);
    expect((await first(questions[0][0]))[0]).toBe("teklif-kale");
    expect((await first(questions[1][0]))[0]).toBe("Tesisatçı");
    expect((await first(questions[2][0])).slice(0, 3)).toContain("Bütçe");
    expect(await first(questions[4][0])).toEqual([]);
    const tile = (await meaning.find("zemin için seçtiğimiz seramiğin metrekare fiyatı", "Ev tadilatı", 5)).hits[0]!;
    expect(tile.snippet).toContain("480 TL/m²");
  }, 180_000);
});
