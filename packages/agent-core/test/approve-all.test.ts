import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, runAgent, type RunOptions } from "../src/agent.js";
import { ToolRegistry, type ToolDef } from "../src/tools.js";
import type { ChatModel } from "../src/provider.js";
import type { AgentEvent, ApprovalDecision } from "../src/events.js";

type Call = { name: string; args?: Record<string, unknown> };

function model(calls: Call[]): ChatModel {
  let i = 0;
  const usage = { promptTokens: 1, completionTokens: 1, ttftMs: 1, tokensPerSec: 1 };
  return {
    id: "fake:approve-all",
    chat: async () => {
      const call = calls[i];
      const id = `c${i++}`;
      return call
        ? { text: "", toolCalls: [{ id, name: call.name, argumentsText: JSON.stringify(call.args ?? {}) }], usage }
        : { text: "Done.", toolCalls: [], usage };
    },
  };
}

const tool = (name: string, extra: Partial<ToolDef<Record<string, unknown>>> = {}, ran: string[] = []): ToolDef<Record<string, unknown>> => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  actionClass: "write-local",
  alwaysAsk: true,
  async run() {
    ran.push(name);
    return "ok";
  },
  ...extra,
});

const appTool = (name: string, ran: string[], extra: Partial<ToolDef<Record<string, unknown>>> = {}) =>
  tool(name, { actionClass: "outbound", approveAll: (a) => ({ key: `app:${String(a.app)}`, app: String(a.app) }), ...extra }, ran);

async function go(tools: ToolDef<Record<string, unknown>>[], calls: Call[], decide: (tool: string, n: number) => ApprovalDecision, opts: Partial<RunOptions> = {}) {
  const registry = new ToolRegistry();
  for (const def of tools) registry.register(def);
  const events: AgentEvent[] = [];
  const asked: string[] = [];
  await runAgent({
    goal: "Tidy the note",
    tools: registry,
    model: model(calls),
    policy: { ...DEFAULT_POLICY },
    requestApproval: async (req) => {
      asked.push(req.tool);
      return decide(req.tool, asked.length);
    },
    emit: (e) => events.push(e),
    maxSteps: calls.length + 2,
    ...opts,
  } as RunOptions);
  return { asked, events };
}

const all = (): ApprovalDecision => ({ kind: "approve_all" });

describe("approve all in this task", () => {
  it("stops asking in that app and for local work, nowhere else", async () => {
    const ran: string[] = [];
    const { asked, events } = await go(
      [appTool("type_key", ran), tool("files_edit", {}, ran)],
      [
        { name: "type_key", args: { app: "TextEdit" } },
        { name: "type_key", args: { app: "TextEdit" } },
        { name: "files_edit" },
        { name: "type_key", args: { app: "Numbers" } },
      ],
      (_tool, n) => (n === 1 ? all() : { kind: "approve" }),
    );
    expect(asked).toEqual(["type_key", "type_key"]);
    expect(ran).toEqual(["type_key", "type_key", "files_edit", "type_key"]);
    const cards = events.filter((e) => e.type === "approval.required");
    expect(cards[0]).toMatchObject({ approveAll: { app: "TextEdit" } });
    expect(cards[1]).toMatchObject({ approveAll: { app: "Numbers" } });
  });

  it("never reaches sending, deleting or a tool that isn't listed", async () => {
    const ran: string[] = [];
    const { asked, events } = await go(
      [tool("files_edit", {}, ran), tool("mail_send", { actionClass: "outbound" }, ran), tool("files_trash", { actionClass: "destructive" }, ran), tool("something_new", {}, ran)],
      [{ name: "files_edit" }, { name: "mail_send" }, { name: "files_trash" }, { name: "something_new" }],
      (name) => (name === "files_edit" ? all() : { kind: "approve" }),
    );
    expect(asked).toEqual(["files_edit", "mail_send", "files_trash", "something_new"]);
    const offered = events.filter((e) => e.type === "approval.required" && e.approveAll).map((e) => (e as { tool: string }).tool);
    expect(offered).toEqual(["files_edit"]);
  });

  it("doesn't let a forged decision approve what the card didn't offer", async () => {
    const ran: string[] = [];
    const { asked } = await go([tool("mail_send", { actionClass: "outbound" }, ran)], [{ name: "mail_send" }, { name: "mail_send" }], all);
    expect(ran).toEqual([]);
    expect(asked).toEqual(["mail_send", "mail_send"]);
  });

  it("still shows a warning card, without the button", async () => {
    const ran: string[] = [];
    let warn = false;
    const authorize: RunOptions["authorize"] = () => (warn ? { kind: "ask", alert: true, reason: "This came from a page." } : { kind: "ask", reason: "ask" });
    const { asked, events } = await go(
      [tool("files_edit", {}, ran)],
      [{ name: "files_edit" }, { name: "files_edit" }, { name: "files_edit" }],
      (_tool, n) => {
        if (n === 1) warn = true;
        return n === 1 ? all() : { kind: "approve" };
      },
      { authorize },
    );
    expect(asked).toEqual(["files_edit", "files_edit", "files_edit"]);
    const warned = events.filter((e) => e.type === "approval.required" && e.alert === true);
    expect(warned).toHaveLength(2);
    expect(warned.every((e) => !("approveAll" in e))).toBe(true);
  });

  it("doesn't get past a refusal", async () => {
    const ran: string[] = [];
    let refuse = false;
    const authorize: RunOptions["authorize"] = () => (refuse ? { kind: "deny", reason: "No." } : { kind: "ask", reason: "ask" });
    await go(
      [tool("files_edit", {}, ran)],
      [{ name: "files_edit" }, { name: "files_edit" }],
      () => {
        refuse = true;
        return all();
      },
      { authorize },
    );
    expect(ran).toEqual([]);
  });

  it("ends when a step's outcome is unknown, and the next step asks", async () => {
    const ran: string[] = [];
    let first = true;
    const typing = appTool("type_key", ran, {
      async run() {
        if (first) {
          first = false;
          ran.push("cut off");
          throw Object.assign(new Error("Text may be partial."), { deliveryUnknown: true });
        }
        ran.push("typed");
        return "ok";
      },
    });
    const { asked, events } = await go(
      [typing],
      [{ name: "type_key", args: { app: "TextEdit" } }, { name: "type_key", args: { app: "TextEdit" } }],
      (_tool, n) => (n === 1 ? all() : { kind: "approve" }),
    );
    expect(asked).toEqual(["type_key", "type_key"]);
    expect(ran).toEqual(["cut off", "typed"]);
    expect(events.filter((e) => e.type === "approval.all_ended")).toHaveLength(1);
  });

  it("stops at once when the session empties it, even for a call already through the gate", async () => {
    const ran: string[] = [];
    const approvedAll = new Set<string>();
    const emptying = appTool("type_key", ran, {
      async run() {
        ran.push("typed");
        approvedAll.clear();
        return "ok";
      },
    });
    const { asked } = await go(
      [emptying],
      [{ name: "type_key", args: { app: "TextEdit" } }, { name: "type_key", args: { app: "TextEdit" } }],
      (_tool, n) => (n === 1 ? all() : { kind: "reject" }),
      { approvedAll },
    );
    expect(asked).toEqual(["type_key", "type_key"]);
    expect(ran).toEqual(["typed"]);
  });

  it("isn't offered on a resumed run, or when the call replaces something", async () => {
    const ran: string[] = [];
    const { events } = await go(
      [tool("files_edit", {}, ran), tool("document_make", { alwaysAskWhen: (a) => a.replaceExisting === true }, ran)],
      [{ name: "files_edit" }],
      () => ({ kind: "approve" }),
      { askBeyondRead: true },
    );
    expect(events.find((e) => e.type === "approval.required")).not.toHaveProperty("approveAll");
    const replacing = await go(
      [tool("document_make", { alwaysAskWhen: (a) => a.replaceExisting === true }, ran)],
      [{ name: "document_make", args: { replaceExisting: true } }, { name: "document_make" }],
      () => ({ kind: "approve" }),
    );
    const cards = replacing.events.filter((e) => e.type === "approval.required");
    expect(cards[0]).not.toHaveProperty("approveAll");
    expect(cards[1]).toHaveProperty("approveAll");
  });

  it("doesn't reach a switched-off tool's card", async () => {
    const ran: string[] = [];
    const switchOn = vi.fn();
    const registry = new ToolRegistry().register<Record<string, unknown>>(tool("files_edit", {}, ran), "files:write");
    registry.setEnabled("files:write", false);
    const events: AgentEvent[] = [];
    const requestApproval = vi.fn(async (): Promise<ApprovalDecision> => all());
    await runAgent({
      goal: "Tidy the note",
      tools: registry,
      model: model([{ name: "files_edit" }, { name: "files_edit" }]),
      policy: { ...DEFAULT_POLICY },
      requestApproval,
      emit: (e) => events.push(e),
      maxSteps: 4,
      switchedOff: () => ({ label: "Files › Write" }),
      switchOn,
    } as RunOptions);
    expect(ran).toEqual([]);
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(switchOn).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "approval.required")).not.toHaveProperty("approveAll");
  });

  it("covers nothing when the tool can't say what it would reach", async () => {
    const ran: string[] = [];
    const { asked, events } = await go(
      [tool("odd", { approveAll: () => { throw new Error("Unavailable."); } }, ran)],
      [{ name: "odd" }, { name: "odd" }],
      () => ({ kind: "approve" }),
    );
    expect(asked).toEqual(["odd", "odd"]);
    expect(events.find((e) => e.type === "approval.required")).not.toHaveProperty("approveAll");
  });
});
