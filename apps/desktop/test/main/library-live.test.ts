/**
 * The library with the real models, measured on a synthetic history.
 *
 * Which lines a request gets is measured with no model for the words alone,
 * and with the meaning model when VUNEMI_LIVE_EMBED is the folder holding
 * the pinned Qwen3-Embedding file and VUNEMI_LIVE_ENGINE the llama-server to
 * run it with.
 *
 * What the chat model does with the lines is measured when VUNEMI_LIVE_CHAT
 * is the address of a llama.cpp server on this Mac and VUNEMI_LIVE_CHAT_MODEL
 * the model it lists: each case runs VUNEMI_LIVE_RUNS times (3) through the
 * same index, tools and runAgent the app uses. A request about something
 * earlier should have the model answer from it, after reading it or from
 * its line when that already says it; one about nothing earlier should have
 * it read nothing. VUNEMI_LIVE_IDS picks cases; VUNEMI_LIVE_SET=holdout
 * measures the requests the thresholds were not chosen with.
 * A measurement, not a gate: it prints rates and, with VUNEMI_LIVE_OUT,
 * writes every answer to that file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModel, runAgent, ToolRegistry } from "@vunemi/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Library, type LibrarySources } from "../../src/main/library/library.js";
import { LibraryStore } from "../../src/main/library/store.js";
import { createLibraryTools } from "../../src/main/library/tools.js";
import { Embedder } from "../../src/main/memory/embedder.js";
import * as written from "./library-cases.js";
import type { LibraryCase } from "./library-cases.js";

const baseUrl = process.env.VUNEMI_LIVE_CHAT;
const modelName = process.env.VUNEMI_LIVE_CHAT_MODEL;
const embedDir = process.env.VUNEMI_LIVE_EMBED;
const binary = process.env.VUNEMI_LIVE_ENGINE ?? null;
const runs = Number(process.env.VUNEMI_LIVE_RUNS ?? 3);
const ids = process.env.VUNEMI_LIVE_IDS?.split(",");
const holdout = process.env.VUNEMI_LIVE_SET === "holdout";
// The holdout's items sit among the first set's: a longer history, as a real one is.
const CONVERSATIONS = holdout ? [...written.CONVERSATIONS, ...written.HOLDOUT_CONVERSATIONS] : written.CONVERSATIONS;
const MEETINGS = holdout ? [...written.MEETINGS, ...written.HOLDOUT_MEETINGS] : written.MEETINGS;
const LIBRARY_CASES = holdout ? written.HOLDOUT_CASES : written.LIBRARY_CASES;
const cases = LIBRARY_CASES.filter((c) => !ids || ids.includes(c.id));

const sources: LibrarySources = {
  conversations: () => CONVERSATIONS.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, runs: c.events.filter((e) => e.type === "run.started").length })),
  conversation: (id) => CONVERSATIONS.find((c) => c.id === id) ?? null,
  meetings: () => MEETINGS.map(({ lines: _lines, ...rest }) => rest),
  meeting: (id) => MEETINGS.find((m) => m.id === id) ?? null,
};

let dir = "";
let store: LibraryStore;
let embedder: Embedder | null = null;
let library: Library;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-library-live-"));
  store = new LibraryStore(dir);
  embedder = embedDir && binary ? new Embedder({ binary, dir: embedDir }) : null;
  library = new Library(store, sources, embedder);
  library.sync();
  // In the app this is done while nothing else runs; here before the first request.
  await library.catchUp();
}, 300_000);
afterAll(async () => {
  await embedder?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** How the lines chosen for the cases compare with what each is about. */
async function selection(lib: Library): Promise<{ found: number; of: number; first: number; stray: number; quiet: number; none: number; rows: string[] }> {
  let found = 0, first = 0, stray = 0, quiet = 0;
  const rows: string[] = [];
  for (const c of cases) {
    const got = (await lib.index(c.goal, new Set()))?.ids ?? [];
    if (c.about) {
      if (got.includes(c.about)) found++;
      if (got[0] === c.about) first++;
      stray += got.filter((id) => id !== c.about).length;
    } else {
      if (got.length === 0) quiet++;
      stray += got.length;
    }
    rows.push(`${c.id.padEnd(16)} ${(c.about ?? "–").padEnd(10)} → ${got.join(", ") || "–"}`);
  }
  return { found, of: cases.filter((c) => c.about).length, first, stray, quiet, none: cases.filter((c) => !c.about).length, rows };
}

describe("the cases", () => {
  it("carry their answer in the item they are about", () => {
    const open = createLibraryTools({ library, sources, current: () => "s_now" }).find((t) => t.name === "library_open")!;
    return Promise.all(LIBRARY_CASES.filter((c) => c.about).map(async (c) => {
      const text = await open.run({ id: store.get(c.about!)!.ref }, {} as never) as string;
      for (const want of c.expect ?? []) expect(want.test(text), `${c.id} ${want}`).toBe(true);
    }));
  });

  it("are found by their words where they share them, and words alone bring little that is stray", async () => {
    const byWords = await selection(new Library(store, sources));
    process.stdout.write(`words only\n${byWords.rows.join("\n")}\n${JSON.stringify({ ...byWords, rows: undefined })}\n`);
    // The eight that use the item's own words; the holdout is measured, not held to a number.
    if (!holdout) expect(byWords.found).toBeGreaterThanOrEqual(Math.min(8, byWords.of));
  });
});

describe.skipIf(!embedDir || !binary)("lines chosen with the meaning model, live", () => {
  it("measures every case", async () => {
    const got = await selection(library);
    process.stdout.write(`words and meaning\n${got.rows.join("\n")}\n${JSON.stringify({ ...got, rows: undefined })}\n`);
    expect(got.of + got.none).toBe(cases.length);
  }, 10 * 60_000);
});

interface Run { answer: string; opened: string[]; searched: number; pass: boolean; ms: number; error?: string }

describe.skipIf(!baseUrl || !modelName)("what the model does with the lines, live", () => {
  it("measures every case", async () => {
    const url = new URL(baseUrl!);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The model must be on this Mac");
    const model = createModel(`llamacpp:${modelName}`, { baseUrl: baseUrl! });
    const results: { id: string; about: string | null; listed: string[]; runs: Run[] }[] = [];
    for (const c of cases) {
      const index = await library.index(c.goal, new Set());
      const row: Run[] = [];
      for (let i = 0; i < runs; i++) {
        const opened: string[] = [];
        let searched = 0;
        const tools = new ToolRegistry();
        for (const tool of createLibraryTools({ library, sources, current: () => "s_now" })) {
          tools.register({
            ...tool,
            run: async (args, ctx) => {
              if (tool.name === "library_open") opened.push(library.byRef(String((args as { id?: unknown }).id ?? ""))?.id ?? "?");
              else searched++;
              return tool.run(args, ctx);
            },
          }, "history");
        }
        const started = Date.now();
        try {
          const result = await runAgent({
            goal: c.goal,
            model,
            tools,
            emit: () => {},
            authorize: () => ({ kind: "allow" }),
            requestApproval: async () => ({ kind: "reject", note: "Nothing here needs approval." }),
            ...(index && { libraryIndex: index.text }),
            contextWindow: 32_768,
            instructions: "Answer in the language of the user's request.",
            maxSteps: 6,
            signal: AbortSignal.timeout(240_000),
          });
          // Everything it said to the user in this task, as the window shows it: a check of ours may have it speak twice.
          const answer = result.messages.filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim()).map((m) => String(m.content)).join("\n\n") || result.detail;
          row.push({ answer, opened, searched, pass: result.status === "done" && passes(c, answer, opened, index?.text ?? ""), ms: Date.now() - started });
        } catch (err) {
          row.push({ answer: "", opened, searched, pass: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
        }
      }
      results.push({ id: c.id, about: c.about, listed: index?.ids ?? [], runs: row });
      process.stdout.write(`${c.id.padEnd(16)} listed ${String(index?.ids.length ?? 0)} ${row.map((r) => (r.error ? "E" : r.pass ? "✓" : "✗")).join("")}  ${row.filter((r) => !r.pass).map((r) => `[opened ${r.opened.join(",") || "–"}; searched ${r.searched}] ${(r.error ?? r.answer).replace(/\s+/g, " ").slice(0, 140)}`).join(" | ")}\n`);
    }
    const group = (rows: typeof results) => {
      const all = rows.flatMap((r) => r.runs);
      return { passed: all.filter((r) => r.pass).length, of: all.length, opened: all.filter((r) => r.opened.length > 0).length, searched: all.filter((r) => r.searched > 0).length, errors: all.filter((r) => r.error).length };
    };
    const all = results.flatMap((r) => r.runs);
    const summary = { about: group(results.filter((r) => r.about)), nothing: group(results.filter((r) => !r.about)), medianMs: all.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(all.length / 2)] };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n${cases.length} synthetic cases, ${runs} runs each; a result about these cases only.\n`);
    if (process.env.VUNEMI_LIVE_OUT) writeFileSync(process.env.VUNEMI_LIVE_OUT, JSON.stringify({ model: modelName, runs, meaning: !!embedder, summary, results }, null, 2), { mode: 0o600 });
    expect(all.length).toBe(cases.length * runs);
  }, 3 * 60 * 60_000);
});

/**
 * About something earlier: answered from it, having read it, or from its
 * line when the line already says it. About nothing earlier: read nothing.
 */
function passes(c: LibraryCase, answer: string, opened: string[], lines: string): boolean {
  if (!c.about) return opened.length === 0;
  const wanted = c.expect ?? [];
  return (opened.includes(c.about) || wanted.every((want) => want.test(lines))) && wanted.every((want) => want.test(answer));
}
