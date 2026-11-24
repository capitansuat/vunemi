import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { TopicAsk } from "../../src/renderer/src/components/TopicAsk.js";
import { foldEvent, type RunView } from "../../src/renderer/src/lib/fold.js";
const holder = vi.hoisted(() => ({ hooks: [] as any[], index: 0 }));
vi.mock("react", async (load) => ({ ...(await load<typeof import("react")>()), useState: (initial: any) => { const i = holder.index++; if (!(i in holder.hooks)) holder.hooks[i] = initial; return [holder.hooks[i], (next: any) => { holder.hooks[i] = next; }]; } }));
function nodes(node: any): any[] { if (!node || typeof node !== "object") return []; return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
const text = (node: any) => nodes(node).flatMap((n) => [n.props?.children].flat(Infinity)).filter((c) => typeof c === "string").join(" ");
beforeEach(() => { holder.hooks = []; holder.index = 0; setLocale("en"); });

it("offers a new topic with its own words", () => {
  const card = TopicAsk({ runId: "r", ask: { topic: "Job hunt", state: "open", isNew: true } });
  expect(text(card)).toContain("Shall I keep what I found in a new topic, “Job hunt”?");
  expect(text(card)).toContain("Each result gets its own page there");
  expect(text(card)).toContain("Yes, make the topic");
});

it("asks for a fitting topic as before", () => {
  const card = TopicAsk({ runId: "r", ask: { topic: "Career", state: "open" } });
  expect(text(card)).toContain("Shall I keep this conversation in “Career”?");
  expect(text(card)).not.toContain("make the topic");
});

it("keeps that the topic is new when the event says so", () => {
  const runs = foldEvent([], { type: "run.started", runId: "r", goal: "g", at: 0 } as never) as RunView[];
  const asked = foldEvent(runs, { type: "topic.suggested", runId: "r", topic: "Job hunt", new: true, at: 1 } as never);
  expect(asked[0]!.topicAsk).toEqual({ topic: "Job hunt", state: "open", isNew: true });
  expect(foldEvent(asked, { type: "topic.resolved", runId: "r", topic: "Job hunt", decision: "linked", at: 2 } as never)[0]!.topicAsk).toEqual({ topic: "Job hunt", state: "linked", isNew: true });
  expect(foldEvent(runs, { type: "topic.suggested", runId: "r", topic: "Career", at: 1 } as never)[0]!.topicAsk).toEqual({ topic: "Career", state: "open" });
});
