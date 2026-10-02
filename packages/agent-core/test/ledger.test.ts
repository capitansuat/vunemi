import { describe, expect, it } from "vitest";
import { promptLedger, ledgerTotals } from "../src/ledger.js";
import { IMAGE_CHARS } from "../src/context.js";
import type { ChatMessage, ToolSpec } from "../src/provider.js";

const spec = (name: string, description = "x".repeat(90)): ToolSpec => ({ name, description, parameters: { type: "object", properties: {} } });

describe("promptLedger", () => {
  const tools = [spec("mail_search"), spec("mail_read"), spec("page_read"), spec("app_guide")];
  const sourceOf = (name: string) => ({ mail_search: "mail:read", mail_read: "mail:read", page_read: "browser:read" })[name];
  const messages: ChatMessage[] = [
    { role: "user", content: "u".repeat(300), images: [{ mime: "image/jpeg", base64: "" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "page_read", argumentsText: "{}" }] },
    { role: "tool", toolCallId: "1", toolName: "page_read", content: "p".repeat(3000) },
    { role: "assistant", content: "a".repeat(60) },
  ];

  it("names every part of the prompt by what it is, never by its content", () => {
    const parts = promptLedger({ core: "c".repeat(600), instructions: "i".repeat(1200), tools, sourceOf, messages }, 3);
    expect(parts).toEqual([
      { kind: "images", name: "images", tokens: IMAGE_CHARS / 3 },
      { kind: "toolOutputs", name: "page_read", tokens: 1000 },
      { kind: "instructions", name: "instructions", tokens: 400 },
      { kind: "system", name: "core", tokens: 200 },
      { kind: "tools", name: "mail", tokens: expect.any(Number) },
      { kind: "conversation", name: "user", tokens: 100 },
      { kind: "tools", name: "browser", tokens: expect.any(Number) },
      { kind: "tools", name: "core", tokens: expect.any(Number) },
      { kind: "conversation", name: "assistant", tokens: 24 },
    ]);
  });

  it("adds up to the whole prompt, so the parts can be trusted", () => {
    const parts = promptLedger({ core: "c".repeat(600), instructions: "i".repeat(1200), tools, sourceOf, messages }, 1);
    const toolChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
    const total = parts.reduce((n, p) => n + p.tokens, 0);
    expect(total).toBe(600 + 1200 + toolChars + 300 + IMAGE_CHARS + "page_read{}".length + 3000 + 60);
  });

  it("leaves out what isn't there", () => {
    const parts = promptLedger({ core: "core", tools: [], messages: [] }, 3);
    expect(parts.map((p) => p.kind)).toEqual(["system"]);
  });
});

describe("ledgerTotals", () => {
  it("sums parts by kind", () => {
    expect(ledgerTotals([
      { kind: "tools", name: "mail", tokens: 10 },
      { kind: "tools", name: "browser", tokens: 5 },
      { kind: "system", name: "core", tokens: 3 },
    ])).toEqual({ tools: 15, system: 3 });
  });
});
