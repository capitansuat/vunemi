import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { Recording } from "../../src/renderer/src/components/MeetingsView.js";
import type { MeetingStatusView } from "../../src/shared/ipc.js";

const holder = vi.hoisted(() => ({ hooks: [] as any[], index: 0 }));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useState: (initial: any) => {
    const i = holder.index++;
    if (!(i in holder.hooks)) holder.hooks[i] = typeof initial === "function" ? initial() : initial;
    return [holder.hooks[i], (next: any) => { holder.hooks[i] = typeof next === "function" ? next(holder.hooks[i]) : next; }];
  },
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));
vi.mock("../../src/renderer/src/store.js", () => ({ useStore: (pick: (s: { model: string }) => unknown) => pick({ model: "lmstudio:m" }) }));

function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
const text = (node: any) => nodes(node).flatMap((n) => [n.props?.children].flat(Infinity)).filter((c) => typeof c === "string").join(" ");
const button = (node: any, label: string) => nodes(node).find((n) => n.type === "button" && text(n).includes(label));
const settle = () => new Promise((done) => setTimeout(done, 0));

type Live = NonNullable<MeetingStatusView["recording"]>;
const START = 1_000_000;
const recording = (over: Partial<Live> = {}): Live => ({ id: "m1", startedAt: START, lines: [], pending: 0, pausedAt: null, pausedMs: 0, ...over });
const draw = (r: Live) => {
  holder.index = 0;
  return Recording({ recording: r, onOpen: () => {} });
};

let api: { meetingsPause: ReturnType<typeof vi.fn>; meetingsResume: ReturnType<typeof vi.fn>; meetingsStop: ReturnType<typeof vi.fn> };
beforeEach(() => {
  holder.hooks = [];
  setLocale("en");
  api = { meetingsPause: vi.fn(async () => {}), meetingsResume: vi.fn(async () => {}), meetingsStop: vi.fn(async () => {}) };
  vi.stubGlobal("window", { vunemi: api });
});

it("offers Pause while recording, and asks for it", async () => {
  const view = draw(recording());
  expect(text(view)).toContain("Recording");
  expect(text(view)).toContain("Let the others know");
  button(view, "Pause").props.onClick();
  await settle();
  expect(api.meetingsPause).toHaveBeenCalledOnce();
  expect(api.meetingsResume).not.toHaveBeenCalled();
});

it("paused, says so, offers Resume, and counts only the time recorded", async () => {
  // 10 minutes in, of which 3 were an earlier break; paused 2 minutes ago.
  vi.spyOn(Date, "now").mockReturnValue(START + 12 * 60_000);
  holder.hooks = [];
  const view = draw(recording({ pausedAt: START + 10 * 60_000, pausedMs: 3 * 60_000 }));
  expect(text(view)).toContain("Paused");
  expect(text(view)).toContain("not recorded");
  expect(text(view)).toContain("07:00");
  expect(button(view, "Pause")).toBeUndefined();
  button(view, "Resume").props.onClick();
  await settle();
  expect(api.meetingsResume).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});

it("shows why a resume failed", async () => {
  api.meetingsResume.mockRejectedValue(new Error("Error invoking remote method: Error: System audio tap failed (-1)"));
  const view = draw(recording({ pausedAt: START }));
  button(view, "Resume").props.onClick();
  await settle();
  expect(text(draw(recording({ pausedAt: START })))).toContain("System audio tap failed (-1)");
});
