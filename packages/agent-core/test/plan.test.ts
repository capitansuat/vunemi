import { describe, expect, it } from "vitest";
import { parsePlan, planNote, proposePlan, worthPlanning } from "../src/plan.js";
import type { ChatModel, ChatResult } from "../src/provider.js";

describe("parsePlan", () => {
  it("reads a numbered plan and trims it to the cap", () => {
    expect(parsePlan("1. Google'a git\n2) Hava durumu ara\n3. Sonucu söyle")).toEqual([
      "Google'a git",
      "Hava durumu ara",
      "Sonucu söyle",
    ]);
    expect(parsePlan([...Array(9)].map((_, i) => `${i + 1}. adım`).join("\n"))).toHaveLength(6);
  });

  it("returns null for NONE, for chatter and for a single step", () => {
    expect(parsePlan("NONE")).toBeNull();
    expect(parsePlan("none\n")).toBeNull();
    expect(parsePlan("Bunu hemen yapabilirim.")).toBeNull();
    expect(parsePlan("1. Saati söyle")).toBeNull();
    expect(parsePlan("1. Saati söyle", true)).toEqual(["Saati söyle"]);
  });

  it("ignores prose around the list and collapses whitespace", () => {
    expect(parsePlan("Plan:\n1.  Sayfayı   aç\nsonra\n2. Fiyatı oku\nHazırım.")).toEqual(["Sayfayı aç", "Fiyatı oku"]);
  });

  it("hands the agreed plan to the model as numbered steps", () => {
    expect(planNote(["a", "b"])).toContain("1. a\n2. b");
  });
});

describe("worthPlanning", () => {
  it("plans a task made of several things", () => {
    expect(worthPlanning("Hepsiburada'da kulaklık ara ve en ucuzunu sepete ekle")).toBe(true);
    expect(worthPlanning("Takvimi aç, sonra yarınki toplantıyı bul")).toBe(true);
    expect(worthPlanning("Şu dosyayı oku ve özetini masaüstüne yaz")).toBe(true);
  });

  it("does not spend a model call on a one-step request", () => {
    // The model would answer NONE to each of these; asking it costs seconds
    // on a local model and buys nothing.
    expect(worthPlanning("Saat kaç?")).toBe(false);
    expect(worthPlanning("Not defterimde ne var")).toBe(false);
    expect(worthPlanning("Takvim penceresini oku")).toBe(false);
  });

  it("does not plan a single research request just because it is long", () => {
    expect(worthPlanning("bu hafta sonu için İstanbul'da uygun fiyatlı bir otel bul bana")).toBe(false);
    expect(worthPlanning("bir yetişkin bir çocuk için Manchester İzmir uçuşlarına bak")).toBe(false);
  });
});

/** A model that thinks until it is told to stop, like a reasoning loop. */
function thinker(opts: { answerAfter?: number } = {}): ChatModel {
  return {
    id: "fake:thinker",
    async chat(req, onChunk): Promise<ChatResult> {
      for (let i = 0; ; i++) {
        if (req.signal.aborted) throw req.signal.reason ?? new DOMException("Aborted", "AbortError");
        if (opts.answerAfter !== undefined && i >= opts.answerAfter) {
          return { text: "1. Postayı aç\n2. Kodu söyle", toolCalls: [], usage: { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null } };
        }
        onChunk({ kind: "thought", text: "hmm, let me reconsider. " });
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

describe("proposePlan", () => {
  it("gives up on a plan that thinks past its length and says so", async () => {
    const steps = await proposePlan(thinker(), "a, b", { signal: new AbortController().signal, budget: { ms: 60_000, chars: 500 } });
    expect(steps).toBe("overrun");
  });

  it("gives up on a plan that takes too long", async () => {
    const steps = await proposePlan(thinker(), "a, b", { signal: new AbortController().signal, budget: { ms: 50, chars: 1e9 } });
    expect(steps).toBe("overrun");
  });

  it("doesn't count reading a long conversation against the plan", async () => {
    // Prefill: nothing streams for a while, longer than the plan's own clock.
    const slowStart: ChatModel = {
      id: "fake:slow-start",
      async chat(req, onChunk) {
        await new Promise((r) => setTimeout(r, 80));
        return thinker({ answerAfter: 3 }).chat(req, onChunk);
      },
    };
    const steps = await proposePlan(slowStart, "a, b", { signal: new AbortController().signal, budget: { ms: 60, chars: 1e9, firstMs: 1_000 } });
    expect(steps).toEqual(["Postayı aç", "Kodu söyle"]);
  });

  it("still ends when nothing streams at all", async () => {
    const silent: ChatModel = {
      id: "fake:silent",
      chat: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason))),
    };
    const steps = await proposePlan(silent, "a, b", { signal: new AbortController().signal, budget: { ms: 60_000, chars: 1e9, firstMs: 30 } });
    expect(steps).toBe("overrun");
  });

  it("still stops when the user stops", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    await expect(proposePlan(thinker(), "a, b", { signal: stop.signal, budget: { ms: 60_000, chars: 1e9 } })).rejects.toThrow();
  });

  it("keeps a plan that arrives within budget", async () => {
    const steps = await proposePlan(thinker({ answerAfter: 3 }), "a, b", { signal: new AbortController().signal });
    expect(steps).toEqual(["Postayı aç", "Kodu söyle"]);
  });
});

it("keeps every file deliverable in a concise fast local plan and disables only planner thinking",async()=>{
 let received:import('../src/provider.js').ChatRequest|undefined;
 const model:ChatModel={id:'vunemi:test',chat:async req=>{received=req;return {text:'1. Read source.csv\n2. Write report.md and verify\n3. Write summary.txt and verify',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}};}};
 await proposePlan(model,'Read source.csv, write report.md and summary.txt',{signal:new AbortController().signal,fastFiles:true});
 expect(received?.thinking).toBe(false);
 expect(received?.messages[0]!.content).toContain('every requested output');
 expect(received?.messages[0]!.content).toContain('basenames');
});

it.each(['NONE','1. Write report.md\n2. Verify report.md','overrun'])('falls back to a complete file plan when fast planning omits outputs (%s)',async text=>{
 const model:ChatModel={id:'vunemi:test',chat:async()=>({text,toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 const steps=await proposePlan(model,'/tmp/source.csv dosyasını oku. /tmp/report.md ve /tmp/summary.txt oluştur.',{signal:new AbortController().signal,fastFiles:true,requiredFiles:['/tmp/report.md','/tmp/summary.txt']});
 expect(steps).toEqual(['Kaynak dosyalarını oku.','report.md: istenen içeriği oluştur ve doğrula.','summary.txt: istenen içeriği oluştur ve doğrula.']);
});

it('distinguishes same-named files in fallback plans',async()=>{
 const model:ChatModel={id:'vunemi:test',chat:async()=>({text:'NONE',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 expect(await proposePlan(model,'Create both files',{signal:new AbortController().signal,fastFiles:true,requiredFiles:['/tmp/a/report.md','/tmp/b/report.md']})).toEqual(['a/report.md: istenen içeriği oluştur ve doğrula.','b/report.md: istenen içeriği oluştur ve doğrula.']);
});

it('does not invent a source-read step from quoted output content',async()=>{
 const model:ChatModel={id:'vunemi:test',chat:async()=>({text:'NONE',toolCalls:[],usage:{promptTokens:1,completionTokens:1,ttftMs:1,tokensPerSec:1}})};
 expect(await proposePlan(model,'/tmp/a.txt dosyasına “/tmp/source.csv dosyasını oku” yaz. /tmp/b.txt dosyasına “text” yaz.',{signal:new AbortController().signal,fastFiles:true,requiredFiles:['/tmp/a.txt','/tmp/b.txt']})).toEqual(['a.txt: istenen içeriği oluştur ve doğrula.','b.txt: istenen içeriği oluştur ve doğrula.']);
});
