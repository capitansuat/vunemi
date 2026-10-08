/**
 * What the real model offers to remember, measured: VUNEMI_LIVE_CHAT is the
 * address of a llama.cpp server on this Mac (http://127.0.0.1:port/v1) and
 * VUNEMI_LIVE_CHAT_MODEL the model it lists. Each synthetic case runs
 * VUNEMI_LIVE_RUNS times (3) through the same propose() the app uses, on an
 * empty store. VUNEMI_LIVE_SET picks "tuning", "holdout" or all the cases. A measurement, not a gate: it prints rates and, with
 * VUNEMI_LIVE_OUT, writes every answer to that file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModel, type ChatModel } from "@vunemi/agent-core";
import { MemoryStore } from "../../src/main/memory/store.js";
import { propose, squash } from "../../src/main/memory/propose.js";
import { PROPOSAL_CASES, type ProposalCase } from "./memory-propose-cases.js";

const baseUrl = process.env.VUNEMI_LIVE_CHAT;
const modelName = process.env.VUNEMI_LIVE_CHAT_MODEL;
const runs = Number(process.env.VUNEMI_LIVE_RUNS ?? 3);
const set = process.env.VUNEMI_LIVE_SET;
const cases = PROPOSAL_CASES.filter((c) => (set === "holdout" ? c.holdout : set === "tuning" ? !c.holdout : true));

interface Run { quotes: string[]; texts: string[]; pass: boolean; ms: number; error?: string }

/** A proposal belongs to the part worth keeping when its quote lies in it, or holds all of it. */
function kept(quote: string, keep: string): boolean {
  const q = squash(quote);
  const k = squash(keep);
  return k.includes(q) || q.includes(k);
}

export function passes(c: ProposalCase, quotes: string[]): boolean {
  if (!c.keep) return quotes.length === 0;
  return quotes.length > 0 && quotes.every((quote) => kept(quote, c.keep!));
}

describe("scoring", () => {
  it("wants nothing from a one-off, and only the lasting part from the rest", () => {
    const [oneOff, , , , , , , , , , lasting] = PROPOSAL_CASES;
    expect(passes(oneOff!, [])).toBe(true);
    expect(passes(oneOff!, ["as option cards"])).toBe(false);
    expect(passes(lasting!, ["always answer me in short bullet points"])).toBe(true);
    expect(passes(lasting!, [])).toBe(false);
    const mixed = PROPOSAL_CASES.find((c) => c.id === "recipe-allergy-en")!;
    expect(passes(mixed, ["I'm allergic to peanuts"])).toBe(true);
    expect(passes(mixed, ["I'm allergic to peanuts", "quick dinner recipe for tonight"])).toBe(false);
  });
});

describe.skipIf(!baseUrl || !modelName)("memory proposals, live", () => {
  let model: ChatModel;
  const dirs: string[] = [];
  beforeAll(() => {
    const url = new URL(baseUrl!);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The model must be on this Mac");
    model = createModel(`llamacpp:${modelName}`, { baseUrl: baseUrl! });
  });
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("measures every case", async () => {
    const results: { id: string; group: string; runs: Run[] }[] = [];
    for (const c of cases) {
      const row: Run[] = [];
      for (let i = 0; i < runs; i++) {
        // A fresh store each time: a note confirmed in one run must not shape the next.
        const dir = mkdtempSync(join(tmpdir(), "vunemi-propose-live-"));
        dirs.push(dir);
        const store = new MemoryStore(dir);
        const started = Date.now();
        try {
          const found = await propose({ model, messages: c.messages, store, meaning: null, signal: AbortSignal.timeout(180_000) });
          const quotes = found.map((p) => p.quote);
          row.push({ quotes, texts: found.map((p) => `${p.kind}: ${p.text}`), pass: passes(c, quotes), ms: Date.now() - started });
        } catch (err) {
          row.push({ quotes: [], texts: [], pass: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
        } finally {
          store.close();
        }
      }
      results.push({ id: c.id, group: c.group, runs: row });
      process.stdout.write(`${c.id.padEnd(20)} ${c.group.padEnd(8)} ${row.map((r) => (r.error ? "E" : r.pass ? "✓" : "✗")).join("")}  ${row.filter((r) => !r.pass).flatMap((r) => r.texts).join(" | ")}\n`);
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
