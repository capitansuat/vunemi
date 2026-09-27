import { describe, expect, it } from "vitest";
import { chatWithinBudget } from "../src/budget.js";
import type { ChatModel, ChatResult } from "../src/provider.js";

const usage = { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null };

function streaming(pieces: number, answer = "ok"): ChatModel {
  return {
    id: "fake:stream",
    async chat(req, onChunk): Promise<ChatResult> {
      for (let i = 0; i < pieces; i++) {
        if (req.signal.aborted) throw req.signal.reason ?? new DOMException("Aborted", "AbortError");
        onChunk({ kind: "thought", text: "x".repeat(100) });
        await new Promise((r) => setTimeout(r, 1));
      }
      return { text: answer, toolCalls: [], usage };
    },
  };
}

describe("chatWithinBudget", () => {
  it("returns the text when the answer fits", async () => {
    const text = await chatWithinBudget(streaming(2, "hello"), [{ role: "user", content: "q" }], new AbortController().signal, { ms: 1_000, chars: 10_000 });
    expect(text).toBe("hello");
  });

  it("says overrun past the length limit", async () => {
    const text = await chatWithinBudget(streaming(50), [{ role: "user", content: "q" }], new AbortController().signal, { ms: 60_000, chars: 500 });
    expect(text).toBe("overrun");
  });

  it("sends no tools", async () => {
    let tools: unknown;
    const model: ChatModel = { id: "fake", async chat(req) { tools = req.tools; return { text: "", toolCalls: [], usage }; } };
    await chatWithinBudget(model, [{ role: "user", content: "q" }], new AbortController().signal, { ms: 1_000, chars: 1_000 });
    expect(tools).toEqual([]);
  });

  it("still throws when the caller stops", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10);
    await expect(chatWithinBudget(streaming(1_000), [{ role: "user", content: "q" }], stop.signal, { ms: 60_000, chars: 1e9 })).rejects.toThrow();
  });
});
