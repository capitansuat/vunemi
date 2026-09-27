import { createModel, DEFAULT_BASE_URLS, listModels, parseModelSpec, ProviderError } from "@vunemi/agent-core";
import type { LocalModelSettings, ModelCheckResult, ProviderStatus } from "../shared/ipc.js";
import { t } from "@vunemi/i18n";
import type { Endpoint } from "./engine/engine.js";

/** Finds the built-in engine's address for a `vunemi:` model, when it is running. */
export type VunemiEndpoint = (spec: string) => Endpoint | null;

export const DEFAULT_MODEL_SETTINGS: LocalModelSettings = {
  endpoints: {
    lmstudio: DEFAULT_BASE_URLS.lmstudio,
    ollama: DEFAULT_BASE_URLS.ollama,
    llamacpp: DEFAULT_BASE_URLS.llamacpp,
  },
  ollamaContextLength: 32_768,
};

const LOCAL = ["lmstudio", "ollama", "llamacpp"] as const;
type LocalKind = typeof LOCAL[number];
const NON_CHAT = /embed|embedding|rerank|whisper|tts/i;

export function validateModelSettings(input: unknown): LocalModelSettings {
  if (!input || typeof input !== "object") throw new Error(t("main.models.invalid"));
  const raw = input as Partial<LocalModelSettings>;
  if (!raw.endpoints || typeof raw.endpoints !== "object") throw new Error("Model adreslerini gir.");
  const endpoints = {} as LocalModelSettings["endpoints"];
  for (const kind of LOCAL) {
    const value = raw.endpoints[kind];
    if (typeof value !== "string" || value.length > 255) throw new Error(t("main.models.badUrl"));
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error(t("main.models.badUrl")); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash) {
      throw new Error(t("main.models.localOnly"));
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (kind === "ollama" && path) throw new Error(t("main.models.ollamaPath"));
    if (kind !== "ollama" && path && path !== "/v1") throw new Error("Model adresi /v1 yoluyla bitmeli.");
    endpoints[kind] = `${url.origin}${kind === "ollama" ? "" : "/v1"}`;
  }
  const context = raw.ollamaContextLength;
  if (!Number.isInteger(context) || context! < 2048 || context! > 131_072) {
    throw new Error(t("main.models.ollamaContext"));
  }
  return { endpoints, ollamaContextLength: context! };
}

export function modelConfig(
  spec: string,
  settings: LocalModelSettings,
  vunemi?: VunemiEndpoint,
): { baseUrl: string; contextLength: number; apiKey?: string } {
  const { kind } = parseModelSpec(spec);
  if (kind === "vunemi") {
    // Not running: the default address refuses, and the task fails as unreachable.
    const endpoint = vunemi?.(spec) ?? null;
    return {
      baseUrl: endpoint?.baseUrl ?? DEFAULT_BASE_URLS.vunemi,
      contextLength: settings.ollamaContextLength,
      ...(endpoint && { apiKey: endpoint.apiKey }),
    };
  }
  if (!LOCAL.includes(kind as LocalKind)) throw new Error(t("main.models.localKinds"));
  return { baseUrl: settings.endpoints[kind as LocalKind], contextLength: settings.ollamaContextLength };
}

export async function checkAgentModel(spec: string, settings: LocalModelSettings, vunemi?: VunemiEndpoint): Promise<ModelCheckResult> {
  const config = modelConfig(spec, settings, vunemi);
  const model = createModel(spec, config);
  const started = performance.now();
  let result: Awaited<ReturnType<typeof model.chat>>;
  try {
    result = await model.chat({
      messages: [
        { role: "system", content: "This is a tool-calling test. Do nothing else. Only call the vunemi_probe tool with token='hazir'." },
        { role: "user", content: "Start the tool-calling test." },
      ],
      tools: [{
        name: "vunemi_probe",
        description: "Vunemi's tool-calling test. It has no side effects.",
        parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
      }],
      signal: AbortSignal.timeout(90_000),
    }, () => {});
  } catch (err) {
    if (err instanceof ProviderError && err.code === "unreachable") throw new Error(t("main.models.unreachable"));
    if (err instanceof ProviderError && err.code === "http") throw new Error(t("main.models.rejected"));
    if (err instanceof Error && err.name === "TimeoutError") throw new Error(t("main.models.timeout"));
    throw new Error(t("main.models.failed"));
  }
  return {
    toolCalled: result.toolCalls.some((call) => {
      if (call.name !== "vunemi_probe") return false;
      try { return (JSON.parse(call.argumentsText) as { token?: unknown }).token === "hazir"; }
      catch { return false; }
    }),
    durationMs: Math.round(performance.now() - started),
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
  };
}

export async function probeProviders(
  settings: LocalModelSettings = DEFAULT_MODEL_SETTINGS,
  vunemiSpecs: string[] = [],
): Promise<ProviderStatus[]> {
  const local = await Promise.all(
    LOCAL.map(async (kind): Promise<ProviderStatus> => {
      const baseUrl = settings.endpoints[kind];
      try {
        const models = await listModels({ kind, baseUrl }, AbortSignal.timeout(3000));
        return { kind, baseUrl, reachable: true, models: models.filter((m) => !NON_CHAT.test(m)) };
      } catch (err) {
        return { kind, baseUrl, reachable: false, models: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  // The built-in engine's models are files on this Mac: listed whether or not it is running.
  return vunemiSpecs.length > 0
    ? [{ kind: "vunemi", baseUrl: "", reachable: true, models: vunemiSpecs }, ...local]
    : local;
}
