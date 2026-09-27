/**
 * Runs the real loop against a real local model. Skipped unless a model is named:
 *
 *   VUNEMI_LIVE_MODEL=lmstudio:qwen/qwen3.6-35b-a3b pnpm test live
 *   VUNEMI_LIVE_MODEL=ollama:qwen3:32b pnpm test live
 */
import { describe, expect, it } from "vitest";
import { createModel, runAgent, ToolRegistry, type AgentEvent } from "../src/index.js";

const spec = process.env.VUNEMI_LIVE_MODEL;

describe.skipIf(!spec)(`live: ${spec}`, () => {
  it("calls a tool, respects approval, and answers using the result", { timeout: 300_000 }, async () => {
    const saved: string[] = [];
    const tools = new ToolRegistry()
      .register({
        name: "get_secret_word",
        description: "Returns today's secret word. Takes no arguments.",
        parameters: { type: "object", properties: {} },
        actionClass: "read",
        run: async () => "pomegranate",
      })
      .register<{ text: string }>({
        name: "save_note",
        description: "Saves a short text note for the user.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "The note text" } },
          required: ["text"],
        },
        actionClass: "write-local",
        run: async ({ text }) => {
          saved.push(text);
          return "Note saved.";
        },
      });

    const events: AgentEvent[] = [];
    const approvals: string[] = [];
    const result = await runAgent({
      goal: "Find out today's secret word, save it as a note, then tell me what it was.",
      model: createModel(spec!),
      tools,
      emit: (e) => events.push(e),
      requestApproval: async (r) => {
        approvals.push(r.tool);
        return { kind: "approve" };
      },
      maxSteps: 8,
    });

    const calls = events.flatMap((e) => (e.type === "tool.proposed" ? [e.tool] : []));
    const usage = events.flatMap((e) => (e.type === "usage" ? [e] : []));
    const thoughts = events.filter((e) => e.type === "thought.delta").length;
    console.log({
      status: result.status,
      calls,
      approvals,
      saved,
      thoughtChunks: thoughts,
      answer: result.detail,
      usage: usage.map((u) => ({ ttftMs: u.ttftMs, tps: u.tokensPerSec, in: u.promptTokens, out: u.completionTokens })),
    });

    expect(result.status).toBe("done");
    expect(calls).toContain("get_secret_word");
    // save_note is write-local, so it must have gone through approval first.
    expect(approvals).toEqual(["save_note"]);
    expect(saved.join(" ").toLowerCase()).toContain("pomegranate");
    expect(result.detail.toLowerCase()).toContain("pomegranate");
  });
});
