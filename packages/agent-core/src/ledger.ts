/**
 * What a request to the model is made of, part by part: the system prompt,
 * the instructions, each connection's tool definitions, the conversation and
 * each tool's output. Names only, never content, so it can be logged with
 * the run and shown to the user. Prompt size is what a local model pays for
 * in time, and it grows quietly unless every part is counted.
 */
import { IMAGE_CHARS, estimateTokens } from "./context.js";
import type { ChatMessage, ToolSpec } from "./provider.js";

export type LedgerKind = "system" | "instructions" | "tools" | "conversation" | "toolOutputs" | "images";

export interface LedgerPart {
  kind: LedgerKind;
  /** The connection for tools ("mail", "core" for built-ins), the tool for outputs. */
  name: string;
  tokens: number;
}

export interface LedgerInput {
  /** The system prompt without instructions. */
  core: string;
  instructions?: string;
  tools: readonly ToolSpec[];
  /** "mail:read" and the like; the part before the colon names the connection. */
  sourceOf?: (name: string) => string | undefined;
  messages: readonly ChatMessage[];
}

/** The parts of one request, largest first. */
export function promptLedger(input: LedgerInput, charsPerToken: number): LedgerPart[] {
  const chars = new Map<string, { kind: LedgerKind; name: string; chars: number }>();
  const add = (kind: LedgerKind, name: string, n: number) => {
    if (n <= 0) return;
    const key = `${kind}:${name}`;
    const part = chars.get(key) ?? { kind, name, chars: 0 };
    part.chars += n;
    chars.set(key, part);
  };

  add("system", "core", input.core.length);
  add("instructions", "instructions", input.instructions?.length ?? 0);
  for (const spec of input.tools) {
    const connection = input.sourceOf?.(spec.name)?.split(":")[0] || "core";
    add("tools", connection, JSON.stringify(spec).length);
  }
  for (const m of input.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      add("toolOutputs", m.toolName, m.content.length);
      continue;
    }
    let n = m.content.length;
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) n += c.name.length + c.argumentsText.length;
    add("conversation", m.role, n);
    if (m.role === "user") add("images", "images", (m.images?.length ?? 0) * IMAGE_CHARS);
  }

  return [...chars.values()]
    .map(({ kind, name, chars: n }) => ({ kind, name, tokens: estimateTokens(n, charsPerToken) }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** Tokens per kind of part, for a one-line summary. */
export function ledgerTotals(parts: readonly LedgerPart[]): Partial<Record<LedgerKind, number>> {
  const totals: Partial<Record<LedgerKind, number>> = {};
  for (const p of parts) totals[p.kind] = (totals[p.kind] ?? 0) + p.tokens;
  return totals;
}
