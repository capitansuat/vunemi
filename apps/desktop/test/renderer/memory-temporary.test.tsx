/** The Memory page marks a temporary topic (made by Vunemi for a web lookup) and keeps it with one click. */
import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { TopicBranch, TopicPanel } from "../../src/renderer/src/components/MemoryView.js";
const holder = vi.hoisted(() => ({ hooks: [] as any[], index: 0 }));
vi.mock("react", async (load) => ({ ...(await load<typeof import("react")>()), useState: (initial: any) => { const i = holder.index++; if (!(i in holder.hooks)) holder.hooks[i] = initial; return [holder.hooks[i], (next: any) => { holder.hooks[i] = typeof next === "function" ? next(holder.hooks[i]) : next; }]; } }));
function nodes(node: any): any[] { if (!node || typeof node !== "object") return []; return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
const text = (node: any) => nodes(node).flatMap((n) => [n.props?.children].flat(Infinity)).filter((c) => typeof c === "string").join(" ");
beforeEach(() => { holder.hooks = []; holder.index = 0; setLocale("en"); });

const topic = (temporary?: true) => ({ name: "Job hunt", about: "Jobs.", updatedAt: 0, ...(temporary && { temporary }), notes: [], sources: [], folders: [], copies: 0, checks: [] });

it("marks a temporary topic and keeps it with one click", async () => {
  const kept: string[] = [];
  (globalThis as any).window = { vunemi: { topicsKeep: async (name: string) => { kept.push(name); } } };
  const branch = TopicBranch({ topic: topic(true), open: false, selected: { kind: "none" } as never, onToggle: () => {}, onSelect: () => {} });
  expect(text(branch)).toContain("Temporary");
  holder.index = 0;
  const panel = TopicPanel({ topic: topic(true), canConvert: false, onSelect: () => {} });
  expect(text(panel)).toContain("Vunemi gathered this from a web lookup. Keep it, or delete it.");
  const keep = nodes(panel).find((n) => n.props?.onClick && text(n).includes("Keep"))!;
  keep.props.onClick();
  await Promise.resolve();
  expect(kept).toEqual(["Job hunt"]);
});

it("shows no mark and no Keep for a topic the user has", () => {
  const branch = TopicBranch({ topic: topic(), open: false, selected: { kind: "none" } as never, onToggle: () => {}, onSelect: () => {} });
  expect(text(branch)).not.toContain("Temporary");
  holder.index = 0;
  const panel = TopicPanel({ topic: topic(), canConvert: false, onSelect: () => {} });
  expect(text(panel)).not.toContain("web lookup");
  expect(nodes(panel).some((n) => n.props?.onClick && text(n).trim() === "Keep")).toBe(false);
});
