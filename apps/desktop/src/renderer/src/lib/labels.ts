/** Words about tools and statuses, looked up in the current language when shown. */

import type { ActionClass, RunStatus } from "@vunemi/agent-core";
import { getLocale, has, t } from "@vunemi/i18n";
import type { CallStatus, CallView } from "./fold.js";

export function actionClassLabel(actionClass: ActionClass): string {
  return t(`actionClass.${actionClass}`);
}

export function toolLabel(tool: string, status: CallStatus): string {
  if (tool === "travel_search_flights") return getLocale() === "tr"
    ? (status === "ok" ? "Uçuş seçeneklerini buldu" : status === "awaiting" ? "Uçuş aramak istiyor" : "Uçuş arıyor")
    : (status === "ok" ? "Found flight options" : status === "awaiting" ? "Wants to search flights" : "Searching flights");
  if (tool === "travel_search_hotels") return getLocale() === "tr"
    ? (status === "ok" ? "Otel seçeneklerini buldu" : status === "awaiting" ? "Otel aramak istiyor" : "Otel arıyor")
    : (status === "ok" ? "Found hotel options" : status === "awaiting" ? "Wants to search hotels" : "Searching hotels");
  const key = `tools.${tool}.${status === "ok" ? "done" : status === "awaiting" ? "ask" : "doing"}`;
  return has(key) ? t(key) : tool;
}

/** A short "what exactly" for a call's row: the preview, or the key argument. */
export function callDetail(call: CallView): string | null {
  if (call.preview) return call.preview;
  const a = (call.args ?? {}) as Record<string, unknown>;
  switch (call.tool) {
    case "page_goto":
      return typeof a.url === "string" ? a.url : null;
    case "page_find":
      return typeof a.query === "string" ? `"${a.query}"` : null;
    case "page_scroll":
      return t(a.direction === "up" ? "callDetail.up" : "callDetail.down");
    case "tabs_focus":
      return t("callDetail.tab", { n: String(a.tab) });
    default:
      return null;
  }
}

export function callStatusLabel(status: CallStatus): string {
  return t(`callStatus.${status}`);
}

export function runStatusLabel(status: RunStatus | "running"): string {
  return t(`runStatus.${status}`);
}

export const PROVIDER_LABEL: Record<string, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  vunemi: "Vunemi",
  openai: "OpenAI",
};

/** `lmstudio:qwen/qwen3.6-35b-a3b` → `qwen3.6-35b-a3b` */
export function shortModelName(spec: string): string {
  const model = spec.slice(spec.indexOf(":") + 1);
  return model.slice(model.lastIndexOf("/") + 1);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return t("time.ms", { n: Math.round(ms) });
  return t("time.seconds", { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
}
