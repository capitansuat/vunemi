import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { SharedSetting } from "../../src/renderer/src/components/MeetingsView.js";
import type { MeetingsSharedView } from "../../src/shared/ipc.js";

const holder = vi.hoisted(() => ({ hooks: [] as any[], index: 0, effect: false }));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useState: (initial: any) => {
    const i = holder.index++;
    if (!(i in holder.hooks)) holder.hooks[i] = typeof initial === "function" ? initial() : initial;
    return [holder.hooks[i], (next: any) => { holder.hooks[i] = typeof next === "function" ? next(holder.hooks[i]) : next; }];
  },
  useEffect: (fn: () => void) => {
    if (!holder.effect) { holder.effect = true; fn(); }
  },
}));

function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
const text = (node: any) => nodes(node).flatMap((n) => [n.props?.children].flat(Infinity)).filter((c) => typeof c === "string").join(" ");
const buttons = (node: any) => nodes(node).filter((n) => n.type === "button");
const draw = () => { holder.index = 0; return SharedSetting(); };
const settle = () => new Promise((done) => setTimeout(done, 0));

const view = (on: boolean): MeetingsSharedView => ({ on, claude: '{"mcpServers":{}}', codex: "[mcp_servers.vunemi-meetings]" });
let api: { meetingsShared: ReturnType<typeof vi.fn>; setMeetingsShared: ReturnType<typeof vi.fn> };
let clipboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  holder.hooks = [];
  holder.index = 0;
  holder.effect = false;
  setLocale("en");
  api = { meetingsShared: vi.fn(async () => view(false)), setMeetingsShared: vi.fn(async (on: boolean) => view(on)) };
  clipboard = vi.fn(async () => {});
  vi.stubGlobal("window", { vunemi: api });
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
});

it("is not there in a build that has no program for it", async () => {
  api.meetingsShared.mockResolvedValue(null);
  draw();
  await settle();
  expect(draw()).toBeNull();
});

it("says where what is read goes, and shows no setup while off", async () => {
  draw();
  await settle();
  const off = draw();
  expect(text(off)).toContain("Let other assistants read meetings");
  expect(text(off)).toContain("so it leaves this Mac");
  expect(text(off)).not.toContain("mcp_servers");
  expect(nodes(off).find((n) => n.type === "input").props.checked).toBe(false);
});

it("turned on, shows what to add to Claude and to Codex, each with its own Copy", async () => {
  draw();
  await settle();
  nodes(draw()).find((n) => n.type === "input").props.onChange({ target: { checked: true } });
  await settle();
  expect(api.setMeetingsShared).toHaveBeenCalledWith(true);
  const on = draw();
  expect(text(on)).toContain("claude_desktop_config.json");
  expect(text(on)).toContain('{"mcpServers":{}}');
  expect(text(on)).toContain("~/.codex/config.toml");
  expect(text(on)).toContain("[mcp_servers.vunemi-meetings]");
  const [claude, codex] = buttons(on);
  codex.props.onClick();
  await settle();
  expect(clipboard).toHaveBeenCalledWith("[mcp_servers.vunemi-meetings]");
  const after = buttons(draw());
  expect(after[0].props.children).toBe("Copy");
  expect(after[1].props.children).toBe("Copied");
  expect(claude.props.children).toBe("Copy");
});

it("says so when the switch could not be saved", async () => {
  api.setMeetingsShared.mockRejectedValue(new Error("Error invoking remote method 'meetings:shared-set': Error: The disk is full."));
  draw();
  await settle();
  nodes(draw()).find((n) => n.type === "input").props.onChange({ target: { checked: true } });
  await settle();
  const failed = draw();
  expect(nodes(failed).find((n) => n.props?.role === "alert").props.children).toBe("The disk is full.");
  expect(nodes(failed).find((n) => n.type === "input").props.checked).toBe(false);
});
