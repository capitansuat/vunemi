/** Read-only local-model benchmark. No Vunemi connection or user data is touched. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createModel, DEFAULT_BASE_URLS, listModels, parseModelSpec, runAgent, ToolRegistry, type AgentEvent, type ChatModel } from "../packages/agent-core/src/index.js";
import { RECORDS, TASK_CASES, routeHint, scoreTask, validateFixtures, type Kind, type TaskCase } from "./task-routing-fixtures.js";

function usage(events: AgentEvent[]) {
  const rows = events.filter((event): event is Extract<AgentEvent, { type: "usage" }> => event.type === "usage");
  const sum = (key: "promptTokens" | "completionTokens") => rows.some((row) => row[key] === null)
    ? null : rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  return { promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens") };
}

function tools(): ToolRegistry {
  const registry = new ToolRegistry();
  const defs: { kind: Exclude<Kind, "chat">; name: string; description: string }[] = [
    { kind: "web", name: "web_read", description: "Read a named synthetic web page. The key is the exact page name in the user's request." },
    { kind: "files", name: "files_read", description: "Read a named synthetic local file. The key is the exact file name in the user's request." },
    { kind: "apps", name: "notes_search", description: "Read a named synthetic Mac Notes note. The key is the exact note name in the user's request." },
  ];
  for (const def of defs) {
    registry.register<{ key: string }>({
      name: def.name,
      description: def.description,
      parameters: { type: "object", properties: { key: { type: "string", description: "Exact synthetic page, file or note name." } }, required: ["key"], additionalProperties: false },
      actionClass: "read",
      untrustedOutput: true,
      run: async ({ key }) => RECORDS[def.kind][key?.trim().toLowerCase()] ?? "No matching synthetic record.",
    });
  }
  return registry;
}

async function one(model: ChatModel, task: TaskCase, variant: "baseline" | "hint", timeoutMs: number) {
  const events: AgentEvent[] = [];
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await runAgent({
      goal: task.goal,
      model,
      tools: tools(),
      emit: (event) => events.push(event),
      authorize: async (request) => request.actionClass === "read" ? { kind: "allow" } : { kind: "deny", reason: "Benchmark tools are read-only." },
      requestApproval: async () => ({ kind: "reject" }),
      instructions: [
        "Answer in the language of the user's request. The tools here contain synthetic records only.",
        ...(variant === "hint" ? [routeHint(task.kind)] : []),
      ].join("\n"),
      maxSteps: 3,
      signal: controller.signal,
    });
    const toolNames = events.filter((event): event is Extract<AgentEvent, { type: "tool.proposed" }> => event.type === "tool.proposed").map((event) => event.tool);
    return {
      id: task.id, kind: task.kind, locale: task.locale, variant,
      status: result.status, toolNames, ...scoreTask(task, toolNames, result.detail, result.status),
      wallMs: Math.round(performance.now() - started), steps: events.filter((event) => event.type === "step.started").length,
      ...usage(events),
      answer: result.detail.slice(0, 300),
    };
  } catch (error) {
    return {
      id: task.id, kind: task.kind, locale: task.locale, variant,
      status: "error", toolNames: [], correctTool: false, correctAnswer: false, success: false,
      wallMs: Math.round(performance.now() - started), steps: events.filter((event) => event.type === "step.started").length,
      ...usage(events), error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

function options(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || !argv[i + 1]) throw new Error("Use --model kind:model [--base-url http://127.0.0.1:port] [--start 0] [--limit 16] [--timeout-ms 90000] [--api-key-file path] [--out path]");
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
  const start = Number(opts.start ?? 0);
  const limit = Number(opts.limit ?? TASK_CASES.length - start);
  const timeoutMs = Number(opts["timeout-ms"] ?? 90_000);
  if (!Number.isInteger(start) || start < 0 || start >= TASK_CASES.length || !Number.isInteger(limit) || limit < 1 || start + limit > TASK_CASES.length || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) {
    throw new Error("Invalid limit or timeout");
  }
  const apiKey = opts["api-key-file"] ? readFileSync(resolve(opts["api-key-file"]), "utf8").trim() : undefined;
  if (apiKey !== undefined && !apiKey) throw new Error("The API key file is empty");
  return { modelSpec: opts.model, kind, baseUrl, start, limit, timeoutMs, apiKey, out: opts.out ? resolve(opts.out) : null };
}

async function main() {
  validateFixtures();
  const opts = options(process.argv.slice(2));
  const available = await listModels({ kind: opts.kind, baseUrl: opts.baseUrl, ...(opts.apiKey && { apiKey: opts.apiKey }) }, AbortSignal.timeout(5000));
  if (!available.includes(opts.modelSpec)) throw new Error(`Model ${opts.modelSpec} is not listed by the local endpoint`);
  const model = createModel(opts.modelSpec, { baseUrl: opts.baseUrl, ...(opts.apiKey && { apiKey: opts.apiKey }) });
  const cases = TASK_CASES.slice(opts.start, opts.start + opts.limit);
  const results: Awaited<ReturnType<typeof one>>[] = [];
  for (const [index, task] of cases.entries()) {
    const order: ("baseline" | "hint")[] = (opts.start + index) % 2 === 0 ? ["baseline", "hint"] : ["hint", "baseline"];
    for (const variant of order) {
      const row = await one(model, task, variant, opts.timeoutMs);
      results.push(row);
      process.stdout.write(`${row.id.padEnd(13)} ${variant.padEnd(8)} ${row.status.padEnd(9)} tool=${row.correctTool} answer=${row.correctAnswer} ${row.wallMs}ms\n`);
    }
  }
  const aggregate = Object.fromEntries((["baseline", "hint"] as const).map((variant) => {
    const rows = results.filter((row) => row.variant === variant);
    const known = rows.filter((row) => row.promptTokens !== null && row.completionTokens !== null);
    return [variant, {
      tasks: rows.length, success: rows.filter((row) => row.success).length,
      correctTool: rows.filter((row) => row.correctTool).length,
      totalWallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
      totalPromptTokens: known.length === rows.length ? known.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0) : null,
      totalCompletionTokens: known.length === rows.length ? known.reduce((sum, row) => sum + (row.completionTokens ?? 0), 0) : null,
    }];
  }));
  const report = { model: opts.modelSpec, endpoint: opts.baseUrl, fixtureCount: cases.length, fixtureStart: opts.start, oracleLabels: true, results, aggregate };
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2), { mode: 0o600 });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Benchmark could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
