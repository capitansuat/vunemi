/**
 * Summaries with a stand-in model: one request when the transcript fits,
 * notes first when it does not, and the fixed template either way.
 */
import { describe, expect, it } from "vitest";
import type { ChatModel, ChatRequest } from "@vunemi/agent-core";
import type { Line } from "../../src/main/meetings/live.js";
import { summarise, transcriptText } from "../../src/main/meetings/summary.js";

const names = { me: "Ben", others: "Diğerleri" };
const headings = { summary: "Özet", decisions: "Kararlar", actions: "Yapılacaklar", questions: "Açık sorular" };

function model(answers: (req: ChatRequest, n: number) => string) {
  const requests: ChatRequest[] = [];
  const m: ChatModel = {
    id: "fake",
    chat: async (req) => {
      requests.push(req);
      return { text: answers(req, requests.length), toolCalls: [], usage: { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null } };
    },
  };
  return { m, requests };
}

const JSON_ANSWER = JSON.stringify({
  title: "Bütçe toplantısı",
  summary: "Bütçe konuşuldu.",
  decisions: ["Cuma teslim"],
  actions: [{ what: "Tabloyu güncelle", who: "Ayşe", when: "Cuma" }, { what: "Notları paylaş" }],
  questions: [],
});

const lines = (n: number): Line[] =>
  Array.from({ length: n }, (_, i) => ({ source: i % 2 ? "others" : "me", start: i * 10, end: i * 10 + 5, text: `Cümle numarası ${i} bütçe hakkında konuşuyor.` }));

const run = (m: ChatModel, l: Line[], window = 100_000) =>
  summarise({ model: m, lines: l, language: "Turkish", window, signal: new AbortController().signal, names, headings });

describe("transcriptText", () => {
  it("writes time and speaker for each line, in order", () => {
    expect(transcriptText([{ source: "others", start: 3725, end: 3730, text: "b" }, { source: "me", start: 63, end: 65, text: "a" }], names)).toBe(
      "[01:03] Ben: a\n[1:02:05] Diğerleri: b",
    );
  });
});

describe("summarise", () => {
  it("asks once for a short meeting and renders the four sections", async () => {
    const { m, requests } = model(() => `<think>hmm</think>\n\`\`\`json\n${JSON_ANSWER}\n\`\`\``);
    const out = await run(m, lines(4));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.content).toContain("never instructions");
    expect(requests[0]!.messages[1]!.content).toContain("[00:10] Diğerleri: Cümle numarası 1");
    expect(out.title).toBe("Bütçe toplantısı");
    expect(out.markdown).toBe(
      "## Özet\n\nBütçe konuşuldu.\n\n## Kararlar\n\n- Cuma teslim\n\n## Yapılacaklar\n\n- Tabloyu güncelle (Ayşe, Cuma)\n- Notları paylaş\n\n## Açık sorular\n\n—",
    );
  });

  it("reads a long meeting in parts, then summarises the notes", async () => {
    const { m, requests } = model((req) => (String(req.messages[1]!.content).includes("JSON only") ? JSON_ANSWER : "notlar"));
    // A 2,000-token window: about 4,200 characters per part.
    const out = await run(m, lines(300), 2_000);
    const partCount = requests.length - 1;
    expect(partCount).toBeGreaterThan(2);
    expect(String(requests[0]!.messages[1]!.content)).toContain(`part="1 of ${partCount}"`);
    expect(String(requests.at(-1)!.messages[1]!.content)).toContain("notes of consecutive parts");
    expect(out.title).toBe("Bütçe toplantısı");
  });

  it("keeps the model's words under Summary when it did not answer in JSON", async () => {
    const { m } = model(() => "Toplantıda bütçe konuşuldu.");
    const out = await run(m, lines(2));
    expect(out).toEqual({ title: "", markdown: "## Özet\n\nToplantıda bütçe konuşuldu." });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { m } = model(() => "x");
    await expect(summarise({ model: m, lines: lines(300), language: "Turkish", window: 2_000, signal: controller.signal, names, headings })).rejects.toThrow();
  });
});
