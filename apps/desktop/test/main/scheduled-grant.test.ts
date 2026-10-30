import { describe, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { createStandingGrant, IDLE_WAIT_MS, type GrantDeps } from "../../src/main/scheduled-grant.js";

const signal = new AbortController().signal;
const EXCEL = { name: "Microsoft Excel", bundleId: "com.microsoft.Excel" };

function deps(over: Partial<GrantDeps> = {}): GrantDeps {
  return {
    permitted: async () => true,
    inputIdle: async () => 60,
    unlocked: async () => true,
    controlOn: () => true,
    resolve: (path) => { if (path.startsWith("/outside")) throw new Error("refused"); return path; },
    onUncertain: () => {},
    sleep: async () => {},
    ...over,
  };
}

describe("what a task was allowed", () => {
  it("is nothing special for a task with nothing allowed", () => {
    expect(createStandingGrant({}, deps())).toBeUndefined();
    expect(createStandingGrant({ apps: [], files: [] }, deps())).toBeUndefined();
  });

  it("with no app, no control tool is covered", () => {
    const grant = createStandingGrant({ files: ["/Docs"] }, deps())!;
    expect(grant.covered).toEqual([]);
    expect(grant.covers("desktop_background_click")).toBe(false);
  });

  it("files: only paths inside what was named, and every path a call names", async () => {
    const grant = createStandingGrant({ files: ["/Docs/report.xlsx", "/Out"] }, deps())!;
    expect(await grant.allows("excel_write_range", { path: "/Docs/report.xlsx" })).toBe(true);
    expect(await grant.allows("files_write", { path: "/Out/a/b.md" })).toBe(true);
    expect(await grant.allows("excel_write_range", { path: "/Docs/report.xlsx.bak" })).toBe(false);
    expect(await grant.allows("excel_write_range", { path: "/Outer/x.xlsx" })).toBe(false);
    expect(await grant.allows("word_export_pdf", { path: "/Out/a.docx", out: "/Other/a.pdf" })).toBe(false);
    expect(await grant.allows("excel_write_range", { path: "/outside/x.xlsx" })).toBe(false);
    expect(await grant.allows("excel_write_range", {})).toBe(false);
    expect(await grant.allows("files_trash", { path: "/Out/a.md" })).toBe(false);
    expect(await grant.allows("system_run", { path: "/Out/a.md" })).toBe(false);
  });

  it("a TextEdit document tool needs TextEdit and its file", async () => {
    const without = createStandingGrant({ apps: [EXCEL], files: ["/Docs"] }, deps())!;
    expect(without.covers("desktop_background_document")).toBe(false);
    const withApp = createStandingGrant({ apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit" }], files: ["/Docs"] }, deps())!;
    expect(withApp.covers("desktop_background_document")).toBe(true);
    expect(await withApp.allows("desktop_background_document", { path: "/Docs/a.txt" })).toBe(true);
    expect(await withApp.allows("desktop_background_document", { path: "/Else/a.txt" })).toBe(false);
  });
});

describe("the user at the Mac", () => {
  it("what leaves mouse and keyboard alone goes straight away, however busy they are", async () => {
    const inputIdle = vi.fn(async () => 0);
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ inputIdle }))!;
    expect(await grant.before("desktop_background_describe", {}, signal)).toBeNull();
    expect(await grant.before("desktop_background_click", {}, signal)).toBeNull();
    expect(inputIdle).not.toHaveBeenCalled();
  });

  it("mouse and keyboard only after looking the other way first", async () => {
    const grant = createStandingGrant({ apps: [EXCEL] }, deps())!;
    expect(await grant.before("desktop_click", {}, signal)).toMatchObject({ refuse: expect.stringContaining("desktop_background_describe") });
    await grant.before("desktop_background_describe", {}, signal);
    expect(await grant.before("desktop_click", {}, signal)).toBeNull();
  });

  it("waits for them to leave it alone, and goes on when they do", async () => {
    let idle = 0;
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ inputIdle: async () => (idle += 3) }))!;
    await grant.before("desktop_background_describe", {}, signal);
    expect(await grant.before("desktop_type", {}, signal)).toBeNull();
    expect(idle).toBeGreaterThanOrEqual(10);
  });

  it("stops after the limit, with the reason", async () => {
    setLocale("en");
    let time = 0;
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ inputIdle: async () => 0, now: () => time, sleep: async () => { time += 60_000; } }))!;
    await grant.before("desktop_background_describe", {}, signal);
    expect(await grant.before("desktop_click", {}, signal)).toEqual({ stop: expect.stringContaining("30") });
    expect(time).toBeGreaterThanOrEqual(IDLE_WAIT_MS);
  });

  it("a locked Mac is not an idle one", async () => {
    let time = 0;
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ unlocked: async () => false, now: () => time, sleep: async () => { time += 60_000; } }))!;
    await grant.before("desktop_background_describe", {}, signal);
    expect(await grant.before("desktop_click", {}, signal)).toHaveProperty("stop");
  });

  it("a helper that can't answer counts as busy, not idle", async () => {
    let time = 0;
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ inputIdle: async () => { throw new Error("busy"); }, now: () => time, sleep: async () => { time += 60_000; } }))!;
    await grant.before("desktop_background_describe", {}, signal);
    expect(await grant.before("desktop_click", {}, signal)).toHaveProperty("stop");
  });
});

describe("what stops a run before it starts acting", () => {
  it("a missing macOS permission stops it, and asks for nothing", async () => {
    setLocale("en");
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ permitted: async () => false }))!;
    expect(await grant.before("desktop_background_describe", {}, signal)).toEqual({ stop: expect.stringContaining("Accessibility") });
    expect(await grant.before("desktop_apps", {}, signal)).toBeNull();
  });

  it("Mac control switched off since it was set up", async () => {
    const grant = createStandingGrant({ apps: [EXCEL] }, deps({ controlOn: () => false }))!;
    expect(await grant.before("desktop_background_click", {}, signal)).toHaveProperty("stop");
  });
});
