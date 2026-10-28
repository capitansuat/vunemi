import {vi} from 'vitest';
vi.mock('../src/journal-coordinator.js',()=>({withJournalAdmission:(_binary:string,_path:string,body:(assert:()=>void)=>unknown)=>body(()=>{})}));
/**
 * Desktop control, tested where it matters: the apps Vunemi refuses to touch,
 * and the fact that it refuses them before the privileged process hears about
 * it at all.
 */
import { existsSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolDef } from "@vunemi/agent-core";
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
  processStartedAt = 1234;
  accessibility = true;
  screenRecording = true;
  grantScreenOnRequest = false;
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
      screenRecording: this.screenRecording,
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
    if(op === "validate_snapshot") return {pid:501,bundleId:"com.apple.Notes",processStartedAt:this.processStartedAt};
    if(op === "request_screen_recording") { if(this.grantScreenOnRequest)this.screenRecording=true; return {asked:this.screenRecording}; }
    if (op === "describe") {
      if (this.after instanceof Error) throw this.after;
      return {...this.after,snapshotId:"observed-1",windowId:7};
    }
    if (op === "screenshot") return { path: String(args.path ?? ""), width: 1024, height: 700 };
    return {snapshotId:"observed-1",windowId:7};
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

  it("retains native validation but exposes no session Always grant for mutations", async () => {
    const scope=[];
    for(const name of ["desktop_click","desktop_key","desktop_type"]){
      const tool=tools.get(name)!;const args={app:"Notes",snapshotId:"observed-1",ref:1,label:"Yeni not",combo:"return",text:"hello"};
      expect(tool.approvalScope?.(args)).toBeUndefined();
      expect(await tool.check?.(args)).toBeNull();
      scope.push(tool.approvalScope?.(args));
      expect(tool.allowSessionApproval).toBeUndefined();
      expect(tool.alwaysAsk).toBe(true);
    }
    expect(scope).toEqual(Array(3).fill(undefined));
    expect(helper.calls.map(c=>c.op)).toEqual(Array(3).fill("validate_snapshot"));
    helper.processStartedAt=5678;
    const relaunched={app:"Notes",snapshotId:"new-snapshot"};
    await tools.get("desktop_key")!.check!(relaunched);
    expect(tools.get("desktop_key")!.approvalScope?.(relaunched)).toBeUndefined();
    const blocked={app:"Terminal",snapshotId:"observed-1"};
    await expect(tools.get("desktop_key")!.check!(blocked)).rejects.toThrow();
    expect(tools.get("desktop_key")!.approvalScope?.(blocked)).toBeUndefined();
  });

  it("refuses clicks without a visible target label before sending input", async () => {
    await expect(call("desktop_click",{app:"Notes",ref:1,snapshotId:"observed-1"})).rejects.toThrow(/label/i);
    expect(helper.calls).toEqual([]);
  });
  it("returns the complete current tree after a click, including unchanged button labels",async()=>{
    helper.after={text:'[1] Button "3"\n[2] Button "Add"',count:2,changed:'+ [9] StaticText "2"'};
    const out=await call("desktop_click",{app:"Notes",ref:1,label:"3",snapshotId:"observed-1"});
    expect(out).toContain('[1] Button "3"');expect(out).toContain('[2] Button "Add"');
    expect(helper.calls.find(c=>c.op==='click')?.args).toMatchObject({ref:1,label:"3"});
  });
  it("requires an observed snapshot before any input and passes the exact identity to the helper", async () => {
    await expect(call("desktop_type", {app:"Notes",text:"hello"})).rejects.toThrow(/snapshot/i);
    expect(helper.calls.some(c=>["type","focus"].includes(c.op))).toBe(false);
    helper.after={text:'[1] TextField "hello"',count:1,changed:'+ [1] TextField "hello"'};
    await call("desktop_type", {app:"Notes",text:"hello",snapshotId:"observed-1"});
    expect(helper.calls.find(c=>c.op==="type")?.args).toMatchObject({app:"501",snapshotId:"observed-1"});
    expect(helper.calls.some(c=>c.op==="focus")).toBe(false);
  });

  it("binds screenshots and post-action observations to the selected window", async () => {
    const shotTools=new Map(createDesktopTools({helper,shotDir:"/tmp/vunemi-test-shots",settleMs:0}).map(t=>[t.name,t]));
    await shotTools.get("desktop_screenshot")!.run({app:"Notes",snapshotId:"observed-1"} as never,ctx());
    expect(helper.calls.find(c=>c.op==="screenshot")?.args).toMatchObject({snapshotId:"observed-1"});
    await call("desktop_click",{app:"Notes",ref:1,label:"Yeni not",snapshotId:"observed-1"});
    expect(helper.calls.find(c=>c.op==="describe")?.args).toMatchObject({windowId:7});
  });

  it("requests the macOS screen permission on first screenshot and does not repeatedly prompt or capture without a grant", async () => {
    helper.screenRecording=false;
    const screenshot=createDesktopTools({helper,shotDir:"/tmp/vunemi-test-shots"}).find(t=>t.name==="desktop_screenshot")!;
    await expect(screenshot.run({app:"Notes"} as never,ctx())).rejects.toThrow(/permission/i);
    await expect(screenshot.run({app:"Notes"} as never,ctx())).rejects.toThrow(/permission/i);
    expect(helper.calls.filter(c=>c.op==="request_screen_recording")).toHaveLength(1);
    expect(helper.calls.some(c=>c.op==="screenshot")).toBe(false);
  });

  it("opens the system permission pane once when macOS has not granted screen access", async () => {
    helper.screenRecording=false;let opened=0;
    const screenshot=createDesktopTools({helper,shotDir:"/tmp/vunemi-test-shots",onScreenPermissionNeeded:async()=>{opened++;}}).find(t=>t.name==="desktop_screenshot")!;
    await expect(screenshot.run({app:"Notes"} as never,ctx())).rejects.toThrow(/permission/i);
    await expect(screenshot.run({app:"Notes"} as never,ctx())).rejects.toThrow(/permission/i);
    expect(opened).toBe(1);
    expect(helper.calls.some(c=>c.op==="screenshot")).toBe(false);
  });

  it("continues capture only after rechecking a newly granted screen permission", async () => {
    helper.screenRecording=false;helper.grantScreenOnRequest=true;
    const screenshot=createDesktopTools({helper,shotDir:"/tmp/vunemi-test-shots"}).find(t=>t.name==="desktop_screenshot")!;
    await screenshot.run({app:"Notes",snapshotId:"observed-1"} as never,ctx());
    expect(helper.calls.map(c=>c.op)).toEqual(["request_screen_recording","screenshot"]);
  });

  it("never lets a blocked app reach the privileged process", async () => {
    await expect(call("desktop_click", { app: "Terminal", ref: 1, label:"New" })).rejects.toThrow(/kabuğu/);
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
      createDesktopTools({ helper, shotDir: "/tmp/vunemi-test-shots" }).map((t) => [t.name, t]),
    );
    const out = await withShots.get("desktop_screenshot")!.run({ app: "Notes" } as never, ctx());
    expect(attached).toEqual([expect.objectContaining({ kind: "image" })]);
    expect(out).toMatch(/desktop_describe/); // told where to look for the words
    expect(helper.calls.some((c) => c.op === "screenshot")).toBe(true);
  });

  it("answers a click with what changed, not with a screenshot", async () => {
    const out = await call("desktop_click", { app: "Notes", ref: 1, label:"Yeni not", snapshotId:"observed-1" });
    expect(out).toContain("Kaydet");
    expect(helper.calls.map((c) => c.op)).toEqual(["click", "describe"]);
  });

  it("looks again after typing and keys, and checks the typed text landed", async () => {
    helper.after = { text: '[1] TextField "Başlık: alışveriş listesi"', count: 1, changed: '+ TextField "Başlık: alışveriş listesi"' };
    const typed = await call("desktop_type", { app: "Notes", text: "alışveriş listesi", snapshotId:"observed-1" });
    expect(typed).toContain("appears in the window");
    expect(helper.calls.map((c) => c.op)).toEqual(["type", "describe"]);
    helper.after = { text: '[1] TextField ""', count: 1, changed: "(değişiklik yok)" };
    await expect(call("desktop_type", { app: "Notes", text: "alışveriş listesi", snapshotId:"observed-1" })).rejects.toThrow(/Text input was not confirmed/);
    expect(await call("desktop_key", { app: "Notes", combo: "cmd+s", snapshotId:"observed-1" })).toMatch(/Nothing in the window changed/);
  });

  it("still answers when the window can't be read after acting", async () => {
    helper.after = new Error("window gone");
    expect(await call("desktop_click", { app: "Notes", ref: 1, label:"Yeni not", snapshotId:"observed-1" })).toMatch(/Could not read the window afterwards \(window gone\)/);
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
    dir = mkdtempSync(join(tmpdir(), "vunemi-helper-"));
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

  it("cancels native input on Stop and safely starts a fresh helper afterwards",async()=>{
    const mark=join(dir,"late-input");
    helper=new Helper(fakeBinary(`if(req.op==="type")setTimeout(()=>{require("node:fs").writeFileSync(req.args.path,"input");process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{}})+"\\n");},500);else process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{op:req.op}})+"\\n");`));
    const stop=new AbortController();const running=helper.call("type",{path:mark},{signal:stop.signal,timeoutMs:200} as never);
    const refused=expect(running).rejects.toThrow(/stopped/);setTimeout(()=>stop.abort(new Error("stopped")),30);await refused;
    expect(await helper.call("ping")).toEqual({op:"ping"});
    await new Promise(r=>setTimeout(r,550));expect(existsSync(mark)).toBe(false);
  });
  it("interrupts an input call if its connector is disabled during execution",async()=>{
    const mark=join(dir,"late-connector-input");
    helper=new Helper(fakeBinary(`setTimeout(()=>{require("node:fs").writeFileSync(req.args.path,"input");process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{}})+"\\n");},500);`));
    let active=true;setTimeout(()=>active=false,30);
    await expect(helper.call("type",{path:mark},{timeoutMs:200,assertActive:()=>{if(!active)throw Error("connector disabled");}} as never)).rejects.toThrow(/connector disabled/);
    await new Promise(r=>setTimeout(r,550));expect(existsSync(mark)).toBe(false);
  });
  it("rejects overlapping requests without queueing and admits the next settled request", async () => {
    helper = new Helper(
      fakeBinary(`setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { op: req.op } }) + "\\n"), req.op === "slow" ? 40 : 0);`),
    );
    const slow=helper.call('slow');
    await expect(helper.call('quick')).rejects.toMatchObject({reasonCode:'helper-busy',noInputSent:true,deliveryUnknown:false});
    expect(await slow).toEqual({op:'slow'});
    expect(await helper.call('quick')).toEqual({op:'quick'});
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

  it("does not verify partial text or a matching button caption as typed content",()=>{
    expect(afterAction({text:'[1] TextField "2"\n[2] Button "235"',changed:'+ [1] TextField "2"'},"235")).toContain("does not appear");
  });
  it("doesn't judge typing that was only spaces", () => {
    expect(afterAction({ text: "x", changed: "+ y" }, "   ")).not.toMatch(/typed text/);
  });
});
