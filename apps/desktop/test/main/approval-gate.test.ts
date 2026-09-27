/** The app's own tools must not act before the user says yes. */
import { runAgent, type AgentEvent, type ChatModel, type ChatResult } from "@vunemi/agent-core";
import { describe, expect, it } from "vitest";
import { createDemoTools } from "../../src/main/demo-tools.js";

function scripted(turns: { text?: string; calls?: { name: string; argumentsText: string }[] }[]): ChatModel {
  let i = 0;
  return {
    id: "fake:scripted",
    async chat(): Promise<ChatResult> {
      const turn = turns[i++] ?? { text: "bitti" };
      return {
        text: turn.text ?? "",
        toolCalls: (turn.calls ?? []).map((c, n) => ({ ...c, id: `c${i}_${n}` })),
        usage: { promptTokens: 1, completionTokens: 1, ttftMs: 1, tokensPerSec: 1 },
      };
    },
  };
}

const write = { name: "scratchpad_write", argumentsText: '{"content":"gizli"}' };

describe("approval gate with the real tools", () => {
  it("waits for approval before writing, and the write never happens if the user never answers", async () => {
    const tools = createDemoTools();
    const events: AgentEvent[] = [];
    const ctrl = new AbortController();
    const result = await runAgent({
      goal: "not yaz",
      model: scripted([{ calls: [write] }]),
      tools,
      emit: (e) => events.push(e),
      requestApproval: () => {
        setTimeout(() => ctrl.abort(), 20); // the user walks away
        return new Promise(() => {});
      },
      signal: ctrl.signal,
    });
    expect(result.status).toBe("stopped");
    expect(events.some((e) => e.type === "approval.required" && e.tool === "scratchpad_write")).toBe(true);
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
    expect(await tools.get("scratchpad_read")!.run({}, ctx())).toBe("(the scratchpad is empty)");
  });

  it("writes once approved, and offers an undo", async () => {
    const tools = createDemoTools();
    const undos: string[] = [];
    await runAgent({
      goal: "not yaz",
      model: scripted([{ calls: [write] }, { text: "yazdım" }]),
      tools,
      emit: () => {},
      requestApproval: async () => ({ kind: "approve" }),
      onUndoOffered: (u) => undos.push(u.label),
    });
    expect(await tools.get("scratchpad_read")!.run({}, ctx())).toBe("gizli");
    expect(undos).toHaveLength(1);
  });
});

const ctx = () => ({
  signal: new AbortController().signal,
  handoff: async () => false,
  offerUndo: () => {},
  attach: () => {},
});
