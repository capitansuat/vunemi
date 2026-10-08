/**
 * When the real model asks with buttons or shows cards, measured:
 * VUNEMI_LIVE_CHAT is the address of a llama.cpp server on this Mac
 * (http://127.0.0.1:port/v1) and VUNEMI_LIVE_CHAT_MODEL the model it lists.
 * Each synthetic case runs VUNEMI_LIVE_RUNS times (3) through runAgent with
 * the choice tools, and stops at the card being measured: what comes after
 * the user's pick is not. Where cards are wanted, a question asked with
 * buttons first is answered with its first option and the run goes on.
 * VUNEMI_LIVE_SET picks "tuning", "holdout" or all the cases, and
 * VUNEMI_LIVE_IDS only the ones it names. A measurement,
 * not a gate: it prints rates and, with VUNEMI_LIVE_OUT, writes every run to
 * that file.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { choiceTools, createModel, runAgent, ToolRegistry, type AgentEvent } from "../src/index.js";
import { CHOICE_CASES, type ChoiceCase } from "./choices-cases.js";

const baseUrl = process.env.VUNEMI_LIVE_CHAT;
const modelName = process.env.VUNEMI_LIVE_CHAT_MODEL;
const runs = Number(process.env.VUNEMI_LIVE_RUNS ?? 3);
const set = process.env.VUNEMI_LIVE_SET;
const ids = process.env.VUNEMI_LIVE_IDS?.split(",");
const cases = CHOICE_CASES.filter((c) => (set === "holdout" ? c.holdout : set === "tuning" ? !c.holdout : true) && (!ids || ids.includes(c.id)));

/** What the user ended up looking at first, and who made it: the model's own call, or the runtime turning its text into a card. */
export type Outcome = "buttons" | "cards" | "plain-question" | "answered" | "error";

export function outcome(events: AgentEvent[], answer: string, want?: ChoiceCase["want"]): { outcome: Outcome; by?: "model" | "runtime"; items?: number } {
  const cards = events.filter((event) => event.type === "choice.asked");
  // Where cards are wanted, buttons before them are a question on the way, not the result.
  const asked = (want === "cards" && cards.find((event) => event.type === "choice.asked" && event.card.kind === "options")) || cards[0];
  if (asked?.type === "choice.asked") {
    const by = /\.(?:list|table)$/.test(asked.callId) ? "runtime" : "model";
    return asked.card.kind === "choice" ? { outcome: "buttons", by } : { outcome: "cards", by, items: asked.card.items.length };
  }
  return { outcome: /[?？]/.test(answer.trim().slice(-200)) ? "plain-question" : "answered" };
}

export function passes(c: ChoiceCase, got: Outcome, items?: number): boolean {
  if (c.want === "cards" && c.count !== undefined && got === "cards" && items !== c.count) return false;
  // A closing "anything else?" is not a card: only a card fails a request with nothing to choose.
  if (c.want === "none") return got === "answered" || got === "plain-question";
  if (c.want === "either") return got === "buttons" || got === "cards";
  return got === c.want;
}

describe("scoring", () => {
  it("reads what the user saw first from the events", () => {
    const asked = (kind: "choice" | "options", callId: string): AgentEvent => ({
      type: "choice.asked", runId: "r", stepId: "s", callId, at: 0,
      card: kind === "choice" ? { kind, question: "Which?", options: ["A", "B"], allowOther: true } : { kind, items: [] },
    });
    expect(outcome([asked("choice", "c1")], "")).toEqual({ outcome: "buttons", by: "model" });
    expect(outcome([asked("options", "s1.table")], "")).toEqual({ outcome: "cards", by: "runtime", items: 0 });
    expect(passes({ id: "x", want: "cards", goal: "", count: 2 }, "cards", 4)).toBe(false);
    expect(outcome([asked("choice", "c1"), asked("options", "c2")], "", "cards").outcome).toBe("cards");
    expect(outcome([asked("choice", "c1")], "", "cards").outcome).toBe("buttons");
    expect(outcome([], "Which cuisine would you like?").outcome).toBe("plain-question");
    expect(outcome([], "Canberra.").outcome).toBe("answered");
    expect(passes({ id: "x", want: "either", goal: "" }, "cards")).toBe(true);
    expect(passes({ id: "x", want: "none", goal: "" }, "plain-question")).toBe(true);
    expect(passes({ id: "x", want: "none", goal: "" }, "buttons")).toBe(false);
  });
});

describe.skipIf(!baseUrl || !modelName)("buttons and cards, live", () => {
  it("measures every case", async () => {
    const url = new URL(baseUrl!);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The model must be on this Mac");
    const model = createModel(`llamacpp:${modelName}`, { baseUrl: baseUrl! });
    const results: { id: string; want: string; runs: { outcome: Outcome; by?: string; items?: number; pass: boolean; ms: number; trace: string; shown: string[]; answer: string }[] }[] = [];
    for (const c of cases) {
      const row: (typeof results)[number]["runs"] = [];
      for (let i = 0; i < runs; i++) {
        const events: AgentEvent[] = [];
        const tools = new ToolRegistry();
        for (const tool of choiceTools()) tools.register(tool);
        const started = Date.now();
        let got: ReturnType<typeof outcome> = { outcome: "error" };
        let answer = "";
        const stop = new AbortController();
        try {
          const result = await runAgent({
            goal: c.goal,
            model,
            tools,
            emit: (event) => events.push(event),
            authorize: () => ({ kind: "allow" }),
            requestApproval: async () => ({ kind: "reject", note: "Nothing here needs approval." }),
            requestChoice: ({ card }) => {
              if (c.want === "cards" && card.kind === "choice") return Promise.resolve({ text: "", index: 0 });
              stop.abort();
              return new Promise(() => {});
            },
            instructions: "Answer in the language of the user's request.",
            maxSteps: 6,
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(240_000)]),
          });
          answer = result.detail;
          got = outcome(events, answer, c.want);
        } catch (err) {
          answer = err instanceof Error ? err.message : String(err);
          if (stop.signal.aborted) got = outcome(events, "", c.want);
        }
        const shown = events.flatMap((event) => event.type !== "choice.asked" ? [] : [event.card.kind === "choice" ? `${event.card.question} [${event.card.options.join(" | ")}]` : `cards: ${event.card.items.map((item) => item.title).join(" | ")}`]);
        // What happened, in order: a second step with no card between is a check the runtime sent.
        const trace = events.flatMap((event) => (event.type === "step.started" ? ["step"] : event.type === "tool.proposed" ? [event.tool] : event.type === "tool.finished" && !event.ok ? ["refused"] : [])).join(" ");
        row.push({ ...got, pass: passes(c, got.outcome, got.items), ms: Date.now() - started, trace, shown, answer: answer.length > 400 ? `${answer.slice(0, 200)} … ${answer.slice(-200)}` : answer });
      }
      results.push({ id: c.id, want: c.want, runs: row });
      process.stdout.write(`${c.id.padEnd(16)} ${c.want.padEnd(8)} ${row.map((r) => (r.pass ? "✓" : "✗")).join("")}  ${row.map((r) => `${r.outcome}${r.by === "runtime" ? "*" : ""}`).join(", ")}\n`);
    }
    const summary = Object.fromEntries([...new Set(results.map((r) => r.want))].map((want) => {
      const all = results.filter((r) => r.want === want).flatMap((r) => r.runs);
      const count = (o: Outcome) => all.filter((r) => r.outcome === o).length;
      const questions = all.map((r) => r.shown.filter((card) => !card.startsWith("cards:")).length);
      return [want, { mostQuestions: Math.max(...questions), passed: all.filter((r) => r.pass).length, of: all.length, byRuntime: all.filter((r) => r.by === "runtime").length, plainQuestion: count("plain-question"), answered: count("answered"), errors: count("error") }];
    }));
    const all = results.flatMap((r) => r.runs);
    const medianMs = all.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(all.length / 2)];
    process.stdout.write(`${JSON.stringify({ summary, medianMs }, null, 2)}\n* made by the runtime from the model's text. ${cases.length} synthetic cases, ${runs} runs each; a result about these cases only.\n`);
    if (process.env.VUNEMI_LIVE_OUT) writeFileSync(process.env.VUNEMI_LIVE_OUT, JSON.stringify({ model: modelName, set: set ?? "all", runs, summary, medianMs, results }, null, 2), { mode: 0o600 });
    expect(all.length).toBe(cases.length * runs);
  }, 4 * 60 * 60_000);
});
