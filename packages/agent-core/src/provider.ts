/**
 * Model providers. One `ChatModel` interface, two wire formats:
 *
 * - OpenAI-compatible `/v1/chat/completions` (LM Studio, llama.cpp, vLLM,
 *   vllm-mlx, and every cloud vendor).
 * - Ollama's native `/api/chat`. Ollama's `/v1` shim can drop `tool_calls`
 *   deltas while streaming, and its default context window is far too small
 *   for an agent, so we talk to it natively and set `num_ctx` explicitly.
 */

import type { JsonSchema } from "./tools.js";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it. May be malformed. */
  argumentsText: string;
}

/** A picture sent to a model that can see, already scaled down. */
export interface ImageData {
  mime: "image/jpeg" | "image/png";
  base64: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImageData[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; toolName: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type StreamChunk =
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    ttftMs: number | null;
    tokensPerSec: number | null;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface ChatModel {
  /** Stable spec string, e.g. `lmstudio:qwen/qwen3.6-35b-a3b`. */
  readonly id: string;
  chat(req: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResult>;
  /** Tokens one request may hold, as the server reports it; null when it can't say. */
  contextWindow?(): Promise<number | null>;
  /** Whether the loaded model takes images. False when the server can't say. */
  vision?(): Promise<boolean>;
  /**
   * How likely each candidate is as the first token of the answer, from one
   * prefill and no text generated: a fast decision (see areas.ts). Null when
   * the server can't say.
   */
  firstTokenOdds?(messages: ChatMessage[], candidates: readonly string[], signal?: AbortSignal): Promise<Record<string, number> | null>;
}

export type ProviderKind = "lmstudio" | "ollama" | "llamacpp" | "vunemi" | "openai";

export class ProviderError extends Error {
  constructor(
    readonly code: "unreachable" | "http" | "bad_stream",
    message: string,
    readonly baseUrl: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  /** Context window to request. Only Ollama honours it per request. */
  contextLength?: number;
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  lmstudio: "http://127.0.0.1:1234/v1",
  ollama: "http://127.0.0.1:11434",
  llamacpp: "http://127.0.0.1:8080/v1",
  // Vunemi's own engine picks a free port each time it starts, so there is no
  // usual address; callers always pass the real one. This one refuses.
  vunemi: "http://127.0.0.1:1/v1",
  openai: "https://api.openai.com/v1",
};

/** The built-in engine's provider name before the app was renamed. */
const LEGACY_ENGINE_PREFIX = "tenami:";

/** A spec saved under the engine's earlier provider name, under the current one. */
export function normalizeModelSpec(spec: string): string {
  return spec.startsWith(LEGACY_ENGINE_PREFIX) ? `vunemi:${spec.slice(LEGACY_ENGINE_PREFIX.length)}` : spec;
}

/** Parses `provider:model`. The model part may itself contain colons (`qwen3:32b`). */
export function parseModelSpec(saved: string): { kind: ProviderKind; model: string } {
  const spec = normalizeModelSpec(saved);
  const sep = spec.indexOf(":");
  if (sep <= 0 || sep === spec.length - 1) {
    throw new Error(`Model spec must look like "provider:model", got "${spec}"`);
  }
  const kind = spec.slice(0, sep);
  if (!(kind in DEFAULT_BASE_URLS)) {
    throw new Error(`Unknown provider "${kind}" in "${spec}"`);
  }
  return { kind: kind as ProviderKind, model: spec.slice(sep + 1) };
}

export function createModel(spec: string, config?: Partial<ProviderConfig>): ChatModel {
  const { kind, model } = parseModelSpec(spec);
  const full: ProviderConfig = {
    kind,
    baseUrl: config?.baseUrl ?? DEFAULT_BASE_URLS[kind],
    ...(config?.apiKey !== undefined && { apiKey: config.apiKey }),
    contextLength: config?.contextLength ?? 32_768,
  };
  return kind === "ollama"
    ? new OllamaModel(spec, model, full)
    : new OpenAICompatibleModel(spec, model, full);
}

export async function listModels(config: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const url =
    config.kind === "ollama" ? `${config.baseUrl}/api/tags` : `${config.baseUrl}/models`;
  const res = await request(url, { method: "GET", headers: headers(config), signal }, config.baseUrl);
  const body = (await res.json()) as {
    data?: { id: string }[];
    models?: { name: string }[];
  };
  const names =
    config.kind === "ollama"
      ? (body.models ?? []).map((m) => m.name)
      : (body.data ?? []).map((m) => m.id);
  return names.map((n) => `${config.kind}:${n}`);
}

/** A number that could be a context window, or null. */
function windowOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 512 ? value : null;
}

/**
 * Asks the server how big a request may be. Each speaks its own dialect, and
 * none of them may hold up a task: three seconds, then the caller's default.
 */
async function probeContextWindow(config: ProviderConfig, model: string): Promise<number | null> {
  if (config.kind === "ollama") return config.contextLength ?? null;
  if (config.kind === "openai") return null;
  try {
    const origin = new URL(config.baseUrl).origin;
    const signal = AbortSignal.timeout(3_000);
    if (config.kind === "lmstudio") {
      const res = await fetch(`${origin}/api/v0/models`, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: string; loaded_context_length?: unknown; max_context_length?: unknown }[] };
      const entry = body.data?.find((m) => m.id === model);
      return windowOf(entry?.loaded_context_length) ?? windowOf(entry?.max_context_length);
    }
    // The built-in engine refuses requests without its key.
    const res = await fetch(`${origin}/props`, { signal, headers: headers(config) });
    if (!res.ok) return null;
    const body = (await res.json()) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
    return windowOf(body.default_generation_settings?.n_ctx) ?? windowOf(body.n_ctx);
  } catch {
    return null;
  }
}

/**
 * Asks the server whether the model can see. Each says so in its own way;
 * silence means no, so a model is never sent images it would ignore.
 */
async function probeVision(config: ProviderConfig, model: string): Promise<boolean> {
  if (config.kind === "openai") return true;
  try {
    const signal = AbortSignal.timeout(3_000);
    if (config.kind === "ollama") {
      const res = await fetch(`${config.baseUrl}/api/show`, {
        method: "POST",
        headers: { ...headers(config), "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal,
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { capabilities?: unknown };
      return Array.isArray(body.capabilities) && body.capabilities.includes("vision");
    }
    const origin = new URL(config.baseUrl).origin;
    if (config.kind === "lmstudio") {
      const res = await fetch(`${origin}/api/v0/models`, { signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { data?: { id?: string; type?: unknown }[] };
      return body.data?.find((m) => m.id === model)?.type === "vlm";
    }
    const res = await fetch(`${origin}/props`, { signal, headers: headers(config) });
    if (!res.ok) return false;
    const body = (await res.json()) as { modalities?: { vision?: unknown } };
    return body.modalities?.vision === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

class OpenAICompatibleModel implements ChatModel {
  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly config: ProviderConfig,
  ) {}

  contextWindow(): Promise<number | null> {
    return probeContextWindow(this.config, this.model);
  }

  vision(): Promise<boolean> {
    return probeVision(this.config, this.model);
  }

  async firstTokenOdds(messages: ChatMessage[], candidates: readonly string[], signal?: AbortSignal): Promise<Record<string, number> | null> {
    // Only llama.cpp's server renders a prompt and reports token odds.
    if (this.config.kind !== "llamacpp" && this.config.kind !== "vunemi") return null;
    try {
      const origin = new URL(this.config.baseUrl).origin;
      const post = async (path: string, body: unknown): Promise<unknown> => {
        const res = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { ...headers(this.config), "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal && { signal }),
        });
        return res.ok ? res.json() : null;
      };
      // The model's own chat template, without thinking: the answer starts at once.
      const rendered = (await post("/apply-template", {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        chat_template_kwargs: { enable_thinking: false },
      })) as { prompt?: unknown } | null;
      if (typeof rendered?.prompt !== "string") return null;
      const done = (await post("/completion", {
        prompt: `${rendered.prompt}Answer: `,
        n_predict: 1,
        n_probs: 20,
        temperature: 0,
        cache_prompt: true,
      })) as { completion_probabilities?: { top_logprobs?: { token?: string; logprob?: number }[] }[] } | null;
      const top = done?.completion_probabilities?.[0]?.top_logprobs;
      if (!Array.isArray(top)) return null;
      const odds: Record<string, number> = Object.fromEntries(candidates.map((c) => [c, 0]));
      for (const t of top) {
        const token = (t.token ?? "").trim();
        if (token in odds && typeof t.logprob === "number") odds[token]! += Math.exp(t.logprob);
      }
      const sum = Object.values(odds).reduce((a, b) => a + b, 0);
      if (sum <= 0) return null;
      for (const c of candidates) odds[c] = odds[c]! / sum;
      return odds;
    } catch {
      return null;
    }
  }

  async chat(req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<ChatResult> {
    const body = {
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: req.messages.map(toOpenAIMessage),
      ...(req.tools.length > 0 && {
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    };

    const timer = new Timer();
    const res = await request(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { ...headers(this.config), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      this.config.baseUrl,
    );

    const splitter = new ThinkSplitter((c) => {
      timer.firstToken();
      onChunk(c);
    });
    const calls = new Map<number, ToolCall>();
    let text = "";
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    for await (const data of sseEvents(res, this.config.baseUrl)) {
      if (data === "[DONE]") break;
      const evt = parseJson(data, this.config.baseUrl) as OpenAIStreamEvent;
      if (evt.usage) {
        promptTokens = evt.usage.prompt_tokens ?? null;
        completionTokens = evt.usage.completion_tokens ?? null;
      }
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        timer.firstToken();
        onChunk({ kind: "thought", text: reasoning });
      }
      if (delta.content) {
        text += splitter.push(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        timer.firstToken();
        const slot = calls.get(tc.index) ?? { id: "", name: "", argumentsText: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.argumentsText += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }
    text += splitter.flush();

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now().toString(36)}` }));

    return { text, toolCalls, usage: timer.usage(promptTokens, completionTokens) };
  }
}

interface OpenAIStreamEvent {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.argumentsText },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "user":
      return m.images?.length
        ? {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
          ],
        }
        : { role: "user", content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

// ---------------------------------------------------------------------------
// Ollama native
// ---------------------------------------------------------------------------

class OllamaModel implements ChatModel {
  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly config: ProviderConfig,
  ) {}

  contextWindow(): Promise<number | null> {
    return probeContextWindow(this.config, this.model);
  }

  vision(): Promise<boolean> {
    return probeVision(this.config, this.model);
  }

  async chat(req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<ChatResult> {
    const body = {
      model: this.model,
      stream: true,
      messages: req.messages.map(toOllamaMessage),
      options: { num_ctx: this.config.contextLength },
      ...(req.tools.length > 0 && {
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    };

    const timer = new Timer();
    const res = await request(
      `${this.config.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { ...headers(this.config), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      this.config.baseUrl,
    );

    const splitter = new ThinkSplitter((c) => {
      timer.firstToken();
      onChunk(c);
    });
    const toolCalls: ToolCall[] = [];
    let text = "";
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    for await (const line of ndjsonLines(res, this.config.baseUrl)) {
      const evt = parseJson(line, this.config.baseUrl) as OllamaStreamEvent;
      if (evt.error) throw new ProviderError("http", evt.error, this.config.baseUrl);
      const msg = evt.message;
      if (msg?.thinking) {
        timer.firstToken();
        onChunk({ kind: "thought", text: msg.thinking });
      }
      if (msg?.content) text += splitter.push(msg.content);
      // Ollama delivers each tool call whole, with arguments already parsed.
      for (const tc of msg?.tool_calls ?? []) {
        timer.firstToken();
        toolCalls.push({
          id: `call_${toolCalls.length}_${Date.now().toString(36)}`,
          name: tc.function.name,
          argumentsText: JSON.stringify(tc.function.arguments ?? {}),
        });
      }
      if (evt.done) {
        promptTokens = evt.prompt_eval_count ?? null;
        completionTokens = evt.eval_count ?? null;
      }
    }
    text += splitter.flush();

    return { text, toolCalls, usage: timer.usage(promptTokens, completionTokens) };
  }
}

interface OllamaStreamEvent {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function: { name: string; arguments?: unknown } }[];
  };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: safeParseObject(c.argumentsText) },
          })),
        }),
      };
    case "tool":
      return { role: "tool", content: m.content, tool_name: m.toolName };
    case "user":
      return { role: "user", content: m.content, ...(m.images?.length && { images: m.images.map((i) => i.base64) }) };
    default:
      return { role: m.role, content: m.content };
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * Many local models emit reasoning inline as `<think>…</think>` inside the
 * content stream. Route it to thoughts so it never leaks into the answer.
 * Tags can be split across chunks, so this buffers any trailing partial tag.
 */
export class ThinkSplitter {
  private inThink = false;
  private pending = "";

  constructor(private readonly emit: (c: StreamChunk) => void) {}

  /** Returns the answer text contained in this piece (thoughts are emitted). */
  push(piece: string): string {
    let buf = this.pending + piece;
    this.pending = "";
    let answer = "";

    while (buf.length > 0) {
      const tag = this.inThink ? "</think>" : "<think>";
      const at = buf.indexOf(tag);
      if (at === -1) {
        // Hold back a suffix that could be the start of the tag.
        const keep = partialSuffix(buf, tag);
        const out = buf.slice(0, buf.length - keep);
        this.pending = buf.slice(buf.length - keep);
        answer += this.route(out);
        break;
      }
      answer += this.route(buf.slice(0, at));
      buf = buf.slice(at + tag.length);
      this.inThink = !this.inThink;
    }
    return answer;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return this.route(rest);
  }

  private route(s: string): string {
    if (!s) return "";
    this.emit({ kind: this.inThink ? "thought" : "text", text: s });
    return this.inThink ? "" : s;
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

class Timer {
  private readonly start = performance.now();
  private first: number | null = null;

  firstToken(): void {
    this.first ??= performance.now();
  }

  usage(promptTokens: number | null, completionTokens: number | null): ChatResult["usage"] {
    const end = performance.now();
    const genMs = this.first === null ? null : end - this.first;
    return {
      promptTokens,
      completionTokens,
      ttftMs: this.first === null ? null : Math.round(this.first - this.start),
      tokensPerSec:
        completionTokens !== null && genMs !== null && genMs > 0
          ? Math.round((completionTokens / genMs) * 1000 * 10) / 10
          : null,
    };
  }
}

function headers(config: ProviderConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}

async function request(url: string, init: RequestInit, baseUrl: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new ProviderError("unreachable", `Cannot reach ${baseUrl}: ${String(err)}`, baseUrl);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new ProviderError("http", `HTTP ${res.status} from ${url}: ${detail}`, baseUrl);
  }
  return res;
}

async function* lines(res: Response, baseUrl: string): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError("bad_stream", "Response has no body", baseUrl);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

async function* sseEvents(res: Response, baseUrl: string): AsyncGenerator<string> {
  for await (const line of lines(res, baseUrl)) {
    if (line.startsWith("data:")) yield line.slice(5).trimStart();
  }
}

async function* ndjsonLines(res: Response, baseUrl: string): AsyncGenerator<string> {
  for await (const line of lines(res, baseUrl)) {
    if (line.trim()) yield line;
  }
}

function parseJson(text: string, baseUrl: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("bad_stream", `Malformed stream event: ${text.slice(0, 200)}`, baseUrl);
  }
}

function safeParseObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
