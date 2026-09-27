/**
 * Desktop control, tested where it matters: the apps Vunemi refuses to touch,
 * and the fact that it refuses them before the privileged process hears about
 * it at all.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolDef } from "@ocak/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterAction, blockedReason, createDesktopTools, Helper } from "../src/index.js";

/** Records whatever a tool hands to the UI, so the tests can look at it. */
const attached: { kind: string; path: string }[] = [];

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: () => {},
  attach: (artifact) => attached.push(artifact),
});

describe("which apps are off limits", () => {
  const blocked = [
    { name: "Terminal", bundleId: "com.apple.Terminal" },
    { name: "iTerm2", bundleId: "com.googlecode.iterm2" },
    { name: "Ghostty", bundleId: "com.mitchellh.ghostty" },
    { name: "Keychain Access", bundleId: "com.apple.keychainaccess" },
    { name: "1Password", bundleId: "com.1password.1password" },
    { name: "System Settings", bundleId: "com.apple.systempreferences" },
    { name: "Vunemi", bundleId: "com.vunemi.app" },
    // The same app under its earlier name, if an old copy is still installed.
    { name: "Tenami", bundleId: "one.ocak.desktop" },
    // After the bundle id moves to the new name's domain, the name still holds.
    { name: "Vunemi", bundleId: "app.example.somethingelse" },
    { name: "Electron", bundleId: "com.github.Electron" },
    { name: "Script Editor", bundleId: "com.apple.ScriptEditor2" },
  ];

  it.each(blocked)("refuses $name", (app) => {
    expect(blockedReason(app)).toBeTruthy();
  });

  it("says why, in a sentence the user can act on", () => {
    expect(blockedReason({ name: "Terminal", bundleId: "com.apple.Terminal" })).toMatch(/kabuğu/);
    expect(blockedReason({ name: "1Password", bundleId: "com.1password.1password" })).toMatch(/parola/i);
    expect(blockedReason({ name: "Vunemi", bundleId: "com.vunemi.app" })).toMatch(/kontrol yüzeyi|izin/);
  });

  it("leaves ordinary apps alone", () => {
    for (const app of [
      { name: "Notes", bundleId: "com.apple.Notes" },
      { name: "Mail", bundleId: "com.apple.mail" },
      { name: "Takvim", bundleId: "com.apple.iCal" },
      { name: "Figma", bundleId: "com.figma.Desktop" },
    ]) {
      expect(blockedReason(app)).toBe(null);
    }
  });

  it("catches a terminal even when the bundle id is unfamiliar", () => {
    expect(blockedReason({ name: "Warp Terminal", bundleId: "com.example.unknown" })).toBeTruthy();
  });
});

/** A Helper that records what it was asked, and never runs anything. */
class FakeHelper extends Helper {
  calls: { op: string; args: Record<string, unknown> }[] = [];
  accessibility = true;
  calendars = false;
  reminders = false;
  /** What the next describe says; a thrown error when it's an Error. */
  after: { text: string; count: number; changed: string | null } | Error = { text: '[1] Button "Yeni not"', count: 1, changed: '+ Button "Kaydet"' };

  constructor() {
    super("/does/not/exist");
  }

  override get installed(): boolean {
    return true;
  }

  override async permissions() {
    return {
      accessibility: this.accessibility,
      screenRecording: false,
      calendars: this.calendars,
      reminders: this.reminders,
    };
  }

  override async apps() {
    return [
      { name: "Notes", bundleId: "com.apple.Notes", pid: 501, frontmost: true },
      { name: "Terminal", bundleId: "com.apple.Terminal", pid: 502, frontmost: false },
    ];
  }

  override async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === "describe") {
      if (this.after instanceof Error) throw this.after;
      return this.after;
    }
    if (op === "screenshot") return { path: String(args.path ?? ""), width: 1024, height: 700 };
    return {};
  }
}

describe("desktop tools", () => {
  let helper: FakeHelper;
  let tools: Map<string, ToolDef>;

  beforeEach(() => {
    helper = new FakeHelper();
    tools = new Map(createDesktopTools({ helper, settleMs: 0 }).map((t) => [t.name, t]));
  });

  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args as never, ctx());

  it("never lets a blocked app reach the privileged process", async () => {
    await expect(call("desktop_click", { app: "Terminal", ref: 1 })).rejects.toThrow(/kabuğu/);
    await expect(call("desktop_type", { app: "Terminal", text: "rm -rf /" })).rejects.toThrow(/Terminal/);
    // Not one request was sent on: the refusal happens on this side.
    expect(helper.calls.filter((c) => c.op !== "permissions")).toEqual([]);
  });

  it("marks the app list, but not the reason, as something the user can read", async () => {
    const out = await call("desktop_apps", {});
    expect(out).toContain("Notes");
    expect(out).toContain("Terminal — off limits");
  });

  it("treats what a window says as untrusted content", () => {
    expect(tools.get("desktop_describe")!.untrustedOutput).toBe(true);
    expect(tools.get("desktop_describe")!.actionClass).toBe("read");
  });

  it("classifies acting in someone's apps as outbound", () => {
    for (const name of ["desktop_click", "desktop_type", "desktop_key"]) {
      expect(tools.get(name)!.actionClass).toBe("outbound");
    }
  });

  it("says what to do when Accessibility has not been granted", async () => {
    helper.accessibility = false;
    await expect(call("desktop_describe", { app: "Notes" })).rejects.toThrow(/System Settings/);
    expect(helper.calls.some((c) => c.op === "describe")).toBe(false);
  });

  it("hands the screenshot to the user, and says plainly that it can't see it", async () => {
    attached.length = 0;
    const withShots = new Map(
      createDesktopTools({ helper, shotDir: "/tmp/ocak-test-shots" }).map((t) => [t.name, t]),
    );
    const out = await withShots.get("desktop_screenshot")!.run({ app: "Notes" } as never, ctx());
    expect(attached).toEqual([expect.objectContaining({ kind: "image" })]);
    expect(out).toMatch(/desktop_describe/); // told where to look for the words
    expect(helper.calls.some((c) => c.op === "screenshot")).toBe(true);
  });

  it("answers a click with what changed, not with a screenshot", async () => {
    const out = await call("desktop_click", { app: "Notes", ref: 1 });
    expect(out).toContain("Kaydet");
    expect(helper.calls.map((c) => c.op)).toEqual(["click", "describe"]);
  });

  it("looks again after typing and keys, and checks the typed text landed", async () => {
    helper.after = { text: '[1] TextField "Başlık: alışveriş listesi"', count: 1, changed: '+ TextField "Başlık: alışveriş listesi"' };
    const typed = await call("desktop_type", { app: "Notes", text: "alışveriş listesi" });
    expect(typed).toContain("appears in the window");
    expect(helper.calls.map((c) => c.op)).toEqual(["focus", "type", "describe"]);
    helper.after = { text: '[1] TextField ""', count: 1, changed: "(değişiklik yok)" };
    const missed = await call("desktop_type", { app: "Notes", text: "alışveriş listesi" });
    expect(missed).toMatch(/Nothing in the window changed/);
    expect(missed).toMatch(/does not appear/);
    expect(await call("desktop_key", { app: "Notes", combo: "cmd+s" })).toMatch(/Nothing in the window changed/);
  });

  it("still answers when the window can't be read after acting", async () => {
    helper.after = new Error("window gone");
    expect(await call("desktop_click", { app: "Notes", ref: 1 })).toMatch(/Could not read the window afterwards \(window gone\)/);
  });

  it("fences what acting tools quote from the window", () => {
    for (const name of ["desktop_click", "desktop_type", "desktop_key"]) expect(tools.get(name)!.untrustedOutput).toBe(true);
  });

  it("names the app by pid, so a rename between calls can't redirect it", async () => {
    await call("desktop_describe", { app: "Notes" });
    expect(helper.calls[0]).toMatchObject({ op: "describe", args: { app: "501" } });
  });
});

describe("the line protocol", () => {
  let dir = "";
  let helper: Helper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocak-helper-"));
  });
  afterEach(() => {
    helper?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for the Swift binary: same protocol, no privileges. */
  function fakeBinary(body: string): string {
    const path = join(dir, "fake-helper");
    writeFileSync(
      path,
      `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => { const req = JSON.parse(line); ${body} });
`,
      "utf8",
    );
    chmodSync(path, 0o755);
    return path;
  }

  it("matches replies to requests, even out of order", async () => {
    helper = new Helper(
      fakeBinary(`setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { op: req.op } }) + "\\n"), req.op === "slow" ? 40 : 0);`),
    );
    const [slow, quick] = await Promise.all([helper.call("slow"), helper.call("quick")]);
    expect(slow).toEqual({ op: "slow" });
    expect(quick).toEqual({ op: "quick" });
  });

  it("turns the helper's error into a rejected call", async () => {
    helper = new Helper(
      fakeBinary(`process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: "Erişilebilirlik izni yok." }) + "\\n");`),
    );
    await expect(helper.call("describe")).rejects.toThrow(/Erişilebilirlik/);
  });

  it("does not hang when the helper dies mid-call", async () => {
    helper = new Helper(fakeBinary(`process.exit(1);`));
    await expect(helper.call("describe")).rejects.toThrow(/kapandı/);
  });

  it("says so plainly when it isn't installed", async () => {
    helper = new Helper(join(dir, "nothing-here"));
    expect(helper.installed).toBe(false);
    await expect(helper.call("apps")).rejects.toThrow(/kurulu değil/);
  });
});

describe("the second look", () => {
  it("tells a missing baseline apart from no change", () => {
    expect(afterAction({ text: "", changed: null })).toMatch(/no earlier look/);
    expect(afterAction({ text: "", changed: "(değişiklik yok)" })).toMatch(/probably had no effect/);
    expect(afterAction({ text: "", changed: "- Sheet" })).toBe("What changed (refs are current):\n- Sheet");
  });

  it("doesn't judge typing that was only spaces", () => {
    expect(afterAction({ text: "x", changed: "+ y" }, "   ")).not.toMatch(/typed text/);
  });
});
