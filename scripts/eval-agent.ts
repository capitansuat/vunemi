/** Runs the synthetic agent evaluation against a local model. Read-only; no Vunemi data is touched. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createModel, DEFAULT_BASE_URLS, listModels, parseModelSpec } from "../packages/agent-core/src/index.js";
import { EVAL_CASES, runCase, summarize, validateCases, type CaseResult } from "./eval-agent-fixtures.js";

function options(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || !argv[i + 1]) throw new Error("Use --model kind:model [--base-url http://127.0.0.1:port] [--only id,id] [--timeout-ms 120000] [--api-key-file path] [--out path]");
    opts[key.slice(2)] = argv[i + 1]!;
  }
  if (!opts.model) throw new Error("--model is required");
  const { kind } = parseModelSpec(opts.model);
  if (!["lmstudio", "ollama", "llamacpp"].includes(kind)) throw new Error("Only local LM Studio, Ollama and llama.cpp endpoints are allowed");
  const baseUrl = opts["base-url"] ?? DEFAULT_BASE_URLS[kind];
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("The model endpoint must be plain HTTP on loopback without credentials");
  }
  const timeoutMs = Number(opts["timeout-ms"] ?? 120_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error("Invalid timeout");
  const only = opts.only ? new Set(opts.only.split(",")) : null;
  const cases = only ? EVAL_CASES.filter((c) => only.has(c.id)) : EVAL_CASES;
  if (cases.length === 0) throw new Error("No case matches --only");
  const apiKey = opts["api-key-file"] ? readFileSync(resolve(opts["api-key-file"]), "utf8").trim() : undefined;
  return { modelSpec: opts.model, kind, baseUrl, timeoutMs, cases, apiKey, out: opts.out ? resolve(opts.out) : null };
}

async function main() {
  validateCases();
  const opts = options(process.argv.slice(2));
  const available = await listModels({ kind: opts.kind, baseUrl: opts.baseUrl, ...(opts.apiKey && { apiKey: opts.apiKey }) }, AbortSignal.timeout(5000));
  if (!available.includes(opts.modelSpec)) throw new Error(`Model ${opts.modelSpec} is not listed by the local endpoint`);
  const model = createModel(opts.modelSpec, { baseUrl: opts.baseUrl, ...(opts.apiKey && { apiKey: opts.apiKey }) });
  const results: CaseResult[] = [];
  for (const c of opts.cases) {
    const row = await runCase(model, c, opts.timeoutMs);
    results.push(row);
    const failed = row.checks.filter((check) => !check.pass).map((check) => check.name);
    process.stdout.write(`${row.id.padEnd(14)} ${row.pass ? "pass" : "FAIL"} ${row.wallMs}ms${failed.length ? `  ✗ ${failed.join("; ")}` : ""}\n`);
  }
  const summary = summarize(results);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${opts.cases.length} synthetic cases; a result about these cases only.\n`);
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ model: opts.modelSpec, endpoint: opts.baseUrl, cases: opts.cases.length, summary, results }, null, 2), { mode: 0o600 });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Evaluation could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
