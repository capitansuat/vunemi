import { describe, expect, it } from "vitest";
import { runAgent, type RunOptions, type StandingGrant } from "../src/agent.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatModel } from "../src/provider.js";

type Step = { text?: string; calls?: { name: string; argumentsText: string }[] };
function scripted(steps: Step[]): { model: ChatModel; offered: string[][] } {
  const offered: string[][] = [];
  let i = 0;
  const model = {
    id: "scripted",
    async chat(req: { tools?: { name: string }[] }, onDelta?: (d: string) => void) {
      offered.push((req.tools ?? []).map((t) => t.name));
      const step = steps[i++] ?? { text: "done" };
      if (step.text) onDelta?.(step.text);
      return {
        text: step.text ?? "",
        toolCalls: (step.calls ?? []).map((c, n) => ({ id: `c${i}-${n}`, name: c.name, argumentsText: c.argumentsText })),
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: step.calls?.length ? "tool_calls" : "stop",
      };
    },
    async contextWindow() { return 100_000; },
    async vision() { return false; },
  };
  return { model: model as unknown as ChatModel, offered };
}

const grant = (over: Partial<StandingGrant> = {}): StandingGrant => ({
  covers: (tool) => tool === "click",
  before: async () => null,
  allows: async () => true,
  ...over,
});

async function run(steps: Step[], opts: Partial<RunOptions>, tools?: ToolRegistry) {
  const { model, offered } = scripted(steps);
  const ran: string[] = [], asked: string[] = [], outputs: string[] = [];
  const registry = tools ?? new ToolRegistry()
    .register({ name: "click", description: "", parameters: { type: "object", properties: {} }, actionClass: "outbound", alwaysAsk: true, run: async () => { ran.push("click"); return "clicked"; } })
    .register({ name: "mail", description: "", parameters: { type: "object", properties: {} }, actionClass: "outbound", alwaysAsk: true, run: async () => { ran.push("mail"); return "sent"; } })
    .register({ name: "rm", description: "", parameters: { type: "object", properties: {} }, actionClass: "destructive", run: async () => { ran.push("rm"); return "gone"; } })
    .register({ name: "focus", description: "", parameters: { type: "object", properties: {} }, actionClass: "read", takesForeground: true, run: async () => { ran.push("focus"); return "front"; } })
    .register({ name: "write", description: "", parameters: { type: "object", properties: {} }, actionClass: "write-local", alwaysAsk: true, run: async () => { ran.push("write"); return "written"; } });
  let detail = "";
  const result = await runAgent({
    goal: "Scheduled task running now: x", model, tools: registry, unattended: true,
    emit: (e) => { if (e.type === "tool.finished") outputs.push(e.output); if (e.type === "run.finished") detail = e.detail; },
    authorize: async (req) => (req.alwaysAsk ? { kind: "ask", reason: "asks" } : { kind: "allow" }),
    requestApproval: async (req) => { asked.push(req.tool); return { kind: "approve" }; },
    ...opts,
  });
  return { ran, asked, outputs, offered, status: result.status, detail };
}

describe("a scheduled task's standing permission", () => {
  it("runs what it covers with no card, and never loads a tool it doesn't cover", async () => {
    const { ran, asked, offered } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant() });
    expect(ran).toEqual(["click"]);
    expect(asked).toEqual([]);
    expect(offered[0]).toContain("click");
    expect(offered[0]).not.toContain("mail");
    expect(offered[0]).not.toContain("rm");
  });

  it("without one, a send-class tool stays out, and a tool that takes the foreground too", async () => {
    const { ran, offered, outputs } = await run([{ calls: [{ name: "click", argumentsText: "{}" }, { name: "focus", argumentsText: "{}" }] }, { text: "done" }], {});
    expect(ran).toEqual([]);
    expect(offered[0]).not.toContain("click");
    expect(offered[0]).not.toContain("focus");
    expect(outputs.join()).toMatch(/can't run in a scheduled task/);
  });

  it("never opens delete, whatever the permission says", async () => {
    const { ran, outputs } = await run([{ calls: [{ name: "rm", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant({ covers: () => true }) });
    expect(ran).toEqual([]);
    expect(outputs[0]).toMatch(/can't run in a scheduled task/);
  });

  it("a call that wasn't allowed is refused, not put on a card nobody is there to answer", async () => {
    const { ran, asked, outputs } = await run([{ calls: [{ name: "write", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant({ allows: async () => false }) });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
    expect(outputs[0]).toMatch(/not what the user allowed/);
  });

  it("a stop ends the run with its reason, and what was done before it", async () => {
    let calls = 0;
    const { ran, status, detail } = await run(
      [{ calls: [{ name: "write", argumentsText: "{}" }] }, { calls: [{ name: "click", argumentsText: "{}" }] }, { text: "never reached" }],
      { standingGrant: grant({ before: async () => (++calls === 2 ? { stop: "The Mac was busy." } : null) }) },
    );
    expect(ran).toEqual(["write"]);
    expect(status).toBe("stopped");
    expect(detail).toContain("The Mac was busy.");
    expect(detail).toContain("write");
  });

  it("a refusal only answers the call", async () => {
    const { ran, status, outputs } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant({ before: async () => ({ refuse: "Look first." }) }) });
    expect(ran).toEqual([]);
    expect(status).toBe("done");
    expect(outputs[0]).toContain("Look first.");
  });

  it("a warning about what was read stops the run instead of showing a card", async () => {
    const { ran, asked, status, detail } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { text: "never" }], {
      standingGrant: grant(),
      authorize: async () => ({ kind: "ask", reason: "The window asked for this.", alert: true }),
    });
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
    expect(status).toBe("stopped");
    expect(detail).toContain("The window asked for this.");
  });

  it("what the Sentinel denies stays denied", async () => {
    const { ran, outputs } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant(), authorize: async () => ({ kind: "deny", reason: "Off." }) });
    expect(ran).toEqual([]);
    expect(outputs[0]).toMatch(/Blocked: Off\./);
  });

  it("an uncertain result stops the run, once, with no retry", async () => {
    let uncertain = 0, tries = 0;
    const tools = new ToolRegistry().register({
      name: "click", description: "", parameters: { type: "object", properties: {} }, actionClass: "outbound", alwaysAsk: true,
      run: async () => { tries++; throw Object.assign(new Error("Lost the reply."), { deliveryUnknown: true }); },
    });
    const { status } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { calls: [{ name: "click", argumentsText: "{}" }] }], { standingGrant: grant({ onUncertain: () => { uncertain++; } }) }, tools);
    expect(status).toBe("stopped");
    expect(tries).toBe(1);
    expect(uncertain).toBe(1);
  });

  it("a check that fails allows nothing", async () => {
    const { ran } = await run([{ calls: [{ name: "click", argumentsText: "{}" }] }, { text: "done" }], { standingGrant: grant({ before: async () => { throw new Error("no reply"); } }) });
    expect(ran).toEqual([]);
  });
});
