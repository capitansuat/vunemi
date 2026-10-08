/**
 * Whether the real model answers from what "@" brought in, measured:
 * VUNEMI_LIVE_CHAT is the address of a llama.cpp server on this Mac
 * (http://127.0.0.1:port/v1) and VUNEMI_LIVE_CHAT_MODEL the model it lists.
 * Each synthetic case runs VUNEMI_LIVE_RUNS times (3) through the same
 * reading, budget and runAgent the app uses, with no tools. VUNEMI_LIVE_SET
 * picks "tuning", "holdout" or all the cases, and VUNEMI_LIVE_IDS only the
 * ones it names. A measurement, not a gate: it prints rates and, with
 * VUNEMI_LIVE_OUT, writes every answer to that file.
 *
 * It also measures the plan made before a run: none of these requests needs
 * one, since each is answered from what was brought in, while work that goes
 * beyond it should still get its plan. VUNEMI_LIVE_PLAN_NOTE=off gives the
 * planner the request alone, as it was before, for a baseline.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createModel, DEFAULT_CHARS_PER_TOKEN, mentionParts, proposePlan, runAgent, ToolRegistry, worthPlanning, type RunMention } from "@vunemi/agent-core";
import { conversationTasks, meetingParts, MENTION_SHARE, mentionTexts, type MentionSource } from "../../src/main/mentions.js";
import { MENTION_CASES, type MentionCase } from "./mentions-cases.js";

const baseUrl = process.env.VUNEMI_LIVE_CHAT;
const modelName = process.env.VUNEMI_LIVE_CHAT_MODEL;
const runs = Number(process.env.VUNEMI_LIVE_RUNS ?? 3);
const set = process.env.VUNEMI_LIVE_SET;
const ids = process.env.VUNEMI_LIVE_IDS?.split(",");
const cases = MENTION_CASES.filter((c) => (set === "holdout" ? c.holdout : set === "tuning" ? !c.holdout : true) && (!ids || ids.includes(c.id)));
const WINDOW = 32_768;

/** What the app would hand the run for this case. */
export function mentionsOf(c: MentionCase): RunMention[] {
  const sources: MentionSource[] = c.brought.map((b) =>
    "gone" in b ? null : b.kind === "conversation" ? { kind: "conversation", tasks: conversationTasks(b.events) } : { kind: "meeting", ...meetingParts(b.meeting) },
  );
  const texts = mentionTexts(sources, Math.floor(WINDOW * DEFAULT_CHARS_PER_TOKEN * MENTION_SHARE));
  return c.brought.map((b, i) => ({ kind: b.kind, id: `case-${i}`, title: b.title, date: b.date, text: texts[i] ?? null }));
}

export function passes(c: MentionCase, answer: string): boolean {
  return c.expect.every((want) => want.test(answer)) && !(c.refuse ?? []).some((no) => no.test(answer));
}

describe("the cases", () => {
  it("carry their answer in what is brought in, and none of the tool noise", () => {
    for (const c of MENTION_CASES) {
      const text = mentionsOf(c).map((m) => m.text ?? "").join("\n");
      expect(text, c.id).not.toContain("PAGE NOISE");
      if (c.group !== "gone") for (const want of c.expect) expect(want.test(text), `${c.id} ${want}`).toBe(true);
    }
  });

  it("scores by what must and must not be in the answer", () => {
    const two = MENTION_CASES.find((c) => c.id === "two-en")!;
    expect(passes(two, "The Dell U2724D, for 520 EUR.")).toBe(true);
    expect(passes(two, "The ThinkPad at 1,480 EUR and the Dell at 520 EUR.")).toBe(false);
    expect(passes(two, "The Dell.")).toBe(false);
  });
});

interface Run { answer: string; pass: boolean; ms: number; error?: string }

describe.skipIf(!baseUrl || !modelName)("answers from mentions, live", () => {
  it("measures every case", async () => {
    const url = new URL(baseUrl!);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The model must be on this Mac");
    const model = createModel(`llamacpp:${modelName}`, { baseUrl: baseUrl! });
    const results: { id: string; group: string; runs: Run[] }[] = [];
    for (const c of cases) {
      const row: Run[] = [];
      for (let i = 0; i < runs; i++) {
        const started = Date.now();
        try {
          const result = await runAgent({
            goal: c.goal,
            model,
            tools: new ToolRegistry(),
            emit: () => {},
            authorize: () => ({ kind: "allow" }),
            requestApproval: async () => ({ kind: "reject", note: "Nothing here needs approval." }),
            mentions: mentionsOf(c),
            contextWindow: WINDOW,
            instructions: "Answer in the language of the user's request.",
            maxSteps: 4,
            signal: AbortSignal.timeout(240_000),
          });
          const answer = [...result.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())?.content ?? result.detail;
          row.push({ answer: String(answer), pass: result.status === "done" && passes(c, String(answer)), ms: Date.now() - started });
        } catch (err) {
          row.push({ answer: "", pass: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
        }
      }
      results.push({ id: c.id, group: c.group, runs: row });
      process.stdout.write(`${c.id.padEnd(20)} ${c.group.padEnd(13)} ${row.map((r) => (r.error ? "E" : r.pass ? "✓" : "✗")).join("")}  ${row.filter((r) => !r.pass).map((r) => (r.error ?? r.answer).replace(/\s+/g, " ").slice(0, 160)).join(" | ")}\n`);
    }
    const groups = [...new Set(results.map((r) => r.group))];
    const summary = Object.fromEntries(groups.map((group) => {
      const all = results.filter((r) => r.group === group).flatMap((r) => r.runs);
      return [group, { passed: all.filter((r) => r.pass).length, of: all.length, errors: all.filter((r) => r.error).length }];
    }));
    const all = results.flatMap((r) => r.runs);
    const medianMs = all.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(all.length / 2)];
    process.stdout.write(`${JSON.stringify({ summary, medianMs }, null, 2)}\n${cases.length} synthetic cases, ${runs} runs each; a result about these cases only.\n`);
    if (process.env.VUNEMI_LIVE_OUT) writeFileSync(process.env.VUNEMI_LIVE_OUT, JSON.stringify({ model: modelName, set: set ?? "all", runs, summary, medianMs, results }, null, 2), { mode: 0o600 });
    expect(all.length).toBe(cases.length * runs);
  }, 3 * 60 * 60_000);
});

describe.skipIf(!baseUrl || !modelName)("plans for requests with mentions, live", () => {
  it("measures how often a plan is made, and what for", async () => {
    const model = createModel(`llamacpp:${modelName}`, { baseUrl: baseUrl! });
    const told = process.env.VUNEMI_LIVE_PLAN_NOTE !== "off";
    // What runAgent hands the planner after the request.
    const about = (c: MentionCase): string => {
      if (!told) return "";
      const parts = mentionParts(mentionsOf(c));
      return parts.list + parts.blocks;
    };
    let plans = 0;
    let asked = 0;
    for (const c of cases.filter((c) => worthPlanning(c.goal))) {
      const row: string[] = [];
      for (let i = 0; i < runs; i++) {
        const planned = await proposePlan(model, c.goal + about(c), { signal: AbortSignal.timeout(240_000) });
        asked++;
        if (Array.isArray(planned)) plans++;
        row.push(Array.isArray(planned) ? planned.join(" / ") : String(planned));
      }
      process.stdout.write(`${c.id.padEnd(20)} ${row.map((r) => (r === "null" ? "–" : "P")).join("")}  ${row.filter((r) => r !== "null").map((r) => r.slice(0, 140)).join(" | ")}\n`);
    }
    // Work that goes beyond what was brought in should still get its plan.
    const work: [id: string, goal: string][] = [
      ["hotel-en", "Take the hotel from @Rome trip, then find its phone number on the web, and draft an email asking about late check-in"],
      ["otel-tr", "@Kapadokya gezisi'ndeki oteli haritada bul, sonra oraya en yakın üç restoranı ara ve bir liste hazırla"],
      ["meeting-summary-en", "From @Monday sync take the new launch date, then add it to my calendar and write a short note for the team"],
    ];
    let workPlans = 0;
    for (const [id, goal] of work) {
      const c = MENTION_CASES.find((x) => x.id === id)!;
      for (let i = 0; i < runs; i++) {
        const planned = await proposePlan(model, goal + about(c), { signal: AbortSignal.timeout(240_000) });
        if (Array.isArray(planned)) workPlans++;
        process.stdout.write(`work ${id.padEnd(20)} ${Array.isArray(planned) ? planned.join(" / ").slice(0, 200) : String(planned)}\n`);
      }
    }
    process.stdout.write(`${JSON.stringify({ told, plans, of: asked, workPlans, workOf: work.length * runs })}\n`);
    expect(asked).toBeGreaterThan(0);
  }, 60 * 60_000);
});
