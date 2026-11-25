import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { TopicAsk } from "../../src/renderer/src/components/TopicAsk.js";
import { foldEvent, type RunView } from "../../src/renderer/src/lib/fold.js";
const holder = vi.hoisted(() => ({ hooks: [] as any[], index: 0 }));
vi.mock("react", async (load) => ({ ...(await load<typeof import("react")>()), useState: (initial: any) => { const i = holder.index++; if (!(i in holder.hooks)) holder.hooks[i] = initial; return [holder.hooks[i], (next: any) => { holder.hooks[i] = next; }]; } }));
function nodes(node: any): any[] { if (!node || typeof node !== "object") return []; return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
const text = (node: any) => nodes(node).flatMap((n) => [n.props?.children].flat(Infinity)).filter((c) => typeof c === "string").join(" ");
beforeEach(() => { holder.hooks = []; holder.index = 0; setLocale("en"); });

it("the temporary card offers Keep with an editable name and Delete, and sends the name typed", async () => {
  const sent: unknown[][] = [];
  (globalThis as any).window = { vunemi: { resolveTopic: async (...a: unknown[]) => { sent.push(a); } } };
  const card = () => { holder.index = 0; return TopicAsk({ runId: "r", ask: { topic: "Job hunt", state: "open", temporary: true } }); };
  const first = card();
  expect(text(first)).toContain("I’ve kept what I found in a temporary topic, “Job hunt”. Keep it?");
  expect(text(first)).toContain("It stays temporary until you choose.");
  const field = nodes(first).find((n) => n.type === "input")!;
  expect(field.props.value).toBe("Job hunt");
  field.props.onChange({ target: { value: "Python jobs" } });
  const buttons = nodes(card()).filter((n) => n.type === "button");
  expect(buttons.map((b) => text(b).trim())).toEqual(["Keep", "Delete"]);
  buttons[0]!.props.onClick();
  buttons[1]!.props.onClick();
  await Promise.resolve();
  expect(sent).toEqual([["r", "kept", "Python jobs"], ["r", "deleted"]]);
});

it("says where it is once kept, and that it went to the Trash once deleted", () => {
  expect(text(TopicAsk({ runId: "r", ask: { topic: "Python jobs", state: "kept", temporary: true } }))).toContain("This conversation is in “Python jobs”.");
  expect(text(TopicAsk({ runId: "r", ask: { topic: "Job hunt", state: "deleted", temporary: true } }))).toContain("The temporary topic was moved to the Trash.");
});

it("asks for a fitting topic as before", () => {
  const card = TopicAsk({ runId: "r", ask: { topic: "Career", state: "open" } });
  expect(text(card)).toContain("Shall I keep this conversation in “Career”?");
  expect(text(card)).not.toContain("temporary");
});

it("keeps that the topic is temporary when the event says so, and the name it was kept under", () => {
  const runs = foldEvent([], { type: "run.started", runId: "r", goal: "g", at: 0 } as never) as RunView[];
  const asked = foldEvent(runs, { type: "topic.suggested", runId: "r", topic: "Job hunt", temporary: true, at: 1 } as never);
  expect(asked[0]!.topicAsk).toEqual({ topic: "Job hunt", state: "open", temporary: true });
  expect(foldEvent(asked, { type: "topic.resolved", runId: "r", topic: "Python jobs", decision: "kept", at: 2 } as never)[0]!.topicAsk).toEqual({ topic: "Python jobs", state: "kept", temporary: true });
  expect(foldEvent(runs, { type: "topic.suggested", runId: "r", topic: "Career", at: 1 } as never)[0]!.topicAsk).toEqual({ topic: "Career", state: "open" });
});
