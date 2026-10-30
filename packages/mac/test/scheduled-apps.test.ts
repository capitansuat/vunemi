import { describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { Helper, type MacApp } from "../src/helper.js";
import { notScheduledReason } from "../src/policy.js";
import { scheduledApp } from "../src/scheduled-apps.js";
import { createDesktopTools } from "../src/tools.js";
import type { ToolContext } from "@vunemi/agent-core";

const app = (name: string, bundleId: string): MacApp => ({ name, bundleId, pid: bundleId.length, frontmost: false });

describe("apps a scheduled task can't be allowed", () => {
  it.each(["com.apple.Safari", "com.google.Chrome", "com.apple.mail", "com.microsoft.Outlook", "com.apple.MobileSMS", "net.whatsapp.WhatsApp", "ru.keepcoder.Telegram", "com.microsoft.teams2", "com.apple.iCal"])("%s", (bundleId) => {
    expect(notScheduledReason({ name: "X", bundleId })).toBeTruthy();
  });
  it("what is off limits anyway stays so", () => {
    for (const bundleId of ["com.apple.Terminal", "com.apple.Passwords", "com.vunemi.app", "com.apple.systempreferences"]) expect(notScheduledReason({ name: "X", bundleId })).toBeTruthy();
  });
  it("by its category too, whoever made it", () => {
    expect(notScheduledReason({ name: "My Bank", bundleId: "com.example.bank", category: "public.app-category.finance" })).toBeTruthy();
    expect(notScheduledReason({ name: "Chat", bundleId: "com.example.chat", category: "public.app-category.social-networking" })).toBeTruthy();
  });
  it("others can", () => {
    expect(notScheduledReason({ name: "Numbers", bundleId: "com.apple.iWork.Numbers", category: "public.app-category.productivity" })).toBeNull();
    expect(notScheduledReason({ name: "Excel", bundleId: "com.microsoft.Excel" })).toBeNull();
  });
});

describe("finding the app a set-up names", () => {
  const look = (open: MacApp[]) => ({ running: async () => open, folders: [] });
  it("an open app, by name or bundle id", async () => {
    await expect(scheduledApp("Microsoft Excel", look([app("Microsoft Excel", "com.microsoft.Excel")]))).resolves.toEqual({ name: "Microsoft Excel", bundleId: "com.microsoft.Excel" });
    await expect(scheduledApp("com.microsoft.excel", look([app("Microsoft Excel", "com.microsoft.Excel")]))).resolves.toMatchObject({ bundleId: "com.microsoft.Excel" });
  });
  it("refuses what isn't allowed, and what isn't there", async () => {
    setLocale("en");
    await expect(scheduledApp("Safari", look([app("Safari", "com.apple.Safari")]))).rejects.toThrow(/can't be given/);
    await expect(scheduledApp("No Such App", look([]))).rejects.toThrow(/No installed app/);
  });
  it("two open apps of one name are never guessed between", async () => {
    await expect(scheduledApp("Same", look([app("Same", "org.one"), app("Same", "org.two")]))).rejects.toThrow(/more than one/);
  });
});

describe("during a task set up for some apps", () => {
  class Bridge extends Helper {
    calls: string[] = [];
    constructor(private readonly list: MacApp[]) { super("/unused"); }
    override async apps() { return this.list; }
    override async permissions() { return { accessibility: true, screenRecording: true, calendars: false, reminders: false }; }
    override async call(op: string) { this.calls.push(op); return { controlMode: "backgroundStrict", snapshotId: "s", windowId: 1, bundleId: "org.allowed", pid: 1, targets: [], extendedTargets: [] }; }
  }
  const ctx = { runId: "r", signal: new AbortController().signal, handoff: async () => false, offerUndo() {}, attach() {} } as ToolContext;

  it("every other app is refused before anything reaches it", async () => {
    const helper = new Bridge([app("Allowed", "org.allowed"), app("Other", "org.other")]);
    const tools = createDesktopTools({ helper, settleMs: 0, onlyApps: () => new Set(["org.allowed"]) });
    const describeTool = tools.find((t) => t.name === "desktop_background_describe")!;
    await expect(describeTool.run({ app: "Other" }, ctx)).rejects.toThrow(/not one of the apps/);
    expect(helper.calls).toEqual([]);
    await expect(tools.find((t) => t.name === "desktop_click")!.check!({ app: "Other", snapshotId: "s", ref: 1, label: "x" } as never, ctx as never)).rejects.toThrow(/not one of the apps/);
    expect(helper.calls).toEqual([]);
    await describeTool.run({ app: "Allowed" }, ctx);
    expect(helper.calls).toEqual(["describe"]);
  });

  it("without a task nothing is limited", async () => {
    const helper = new Bridge([app("Other", "org.other")]);
    const tools = createDesktopTools({ helper, settleMs: 0, onlyApps: () => null });
    await tools.find((t) => t.name === "desktop_background_describe")!.run({ app: "Other" }, ctx);
    expect(helper.calls).toEqual(["describe"]);
  });
});
