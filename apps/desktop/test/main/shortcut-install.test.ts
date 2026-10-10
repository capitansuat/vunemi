/**
 * Putting a built shortcut among the user's. What matters: the file is made
 * only from a draft the menu lets through, it is signed before it is opened,
 * Vunemi reads the user's answer from their shortcuts and never gives it, and
 * a file that can't be made ends in an empty shortcut rather than in nothing.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { ShortcutRefused } from "@vunemi/apps";
import { ShortcutInstaller } from "../../src/main/shortcut-install.js";

const draft = { name: "Remind me", steps: [{ block: "ask", prompt: "Of what?" }, { block: "addReminder", title: "{1}" }] };

let dir: string;
let calls: string[][];
/** The user's shortcuts, as `shortcuts list` gives them one after another. */
let lists: string[];
let fails: string | null;

const installer = (over: { answerMs?: number } = {}) =>
  new ShortcutInstaller({
    dir,
    uuid: () => "u",
    answerMs: over.answerMs ?? 200,
    lookEveryMs: 5,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (fails && args[0] === fails) throw new Error("it went wrong");
      return args[0] === "list" ? (lists.length > 1 ? lists.shift()! : lists[0]!) : "";
    },
  });
const done = () => calls.filter((c) => c[1] !== "list").map((c) => `${c[0]!.split("/").pop()} ${c[1]}`);

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "vunemi-shortcuts-")), "shortcuts");
  calls = [];
  lists = ["Other\n"];
  fails = null;
});

describe("ShortcutInstaller", () => {
  it("makes the file, has it signed, opens it, and sees the user add it", async () => {
    lists = ["Other\n", "Other\n", "Other\nRemind me\n"];
    expect(await installer().install(draft)).toEqual({ state: "added", name: "Remind me" });
    expect(done()).toEqual(["plutil -convert", "shortcuts sign", "open -a"]);
    const sign = calls.find((c) => c[1] === "sign")!;
    expect(sign.slice(1)).toEqual(["sign", "--mode", "anyone", "--input", join(dir, "unsigned", "Remind me.shortcut"), "--output", join(dir, "Remind me.shortcut")]);
    expect(calls.find((c) => c[0] === "/usr/bin/open")).toEqual(["/usr/bin/open", "-a", "Shortcuts", "--", join(dir, "Remind me.shortcut")]);
    const xml = readFileSync(join(dir, "unsigned", "Remind me.xml"), "utf8");
    expect(xml).toContain("<string>is.workflow.actions.addnewreminder</string>");
    expect(xml).toContain("<string>Of what?</string>");
    // The files are the user's alone.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "unsigned", "Remind me.xml")).mode & 0o777).toBe(0o600);
  });

  it("says so when the user does not add it, and stops looking", async () => {
    expect(await installer({ answerMs: 40 }).install(draft)).toEqual({ state: "notAdded", name: "Remind me" });
    expect(done()).toEqual(["plutil -convert", "shortcuts sign", "open -a"]);
  });

  it("stops looking when the run is stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await installer({ answerMs: 60_000 }).install(draft, stop.signal)).toEqual({ state: "notAdded", name: "Remind me" });
  });

  it("builds nothing over a shortcut the user already has", async () => {
    lists = ["Remind me\nOther\n"];
    expect(await installer().install(draft)).toEqual({ state: "exists", name: "Remind me" });
    expect(done()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("opens an empty shortcut when the file can't be signed, and says why", async () => {
    fails = "sign";
    expect(await installer().install(draft)).toEqual({ state: "failed", name: "Remind me", reason: "it went wrong" });
    expect(done()).toEqual(["plutil -convert", "shortcuts sign", "open shortcuts://create-shortcut"]);
  });

  it("builds anyway when the user's shortcuts can't be read beforehand", async () => {
    fails = "list";
    expect(await installer({ answerMs: 20 }).install(draft)).toEqual({ state: "notAdded", name: "Remind me" });
    expect(done()).toEqual(["plutil -convert", "shortcuts sign", "open -a"]);
  });

  it("makes no file from a draft the menu refuses", async () => {
    await expect(installer().install({ name: "x", steps: [{ block: "runShellScript", script: "id" }] })).rejects.toThrow(ShortcutRefused);
    await expect(installer().install({ name: "../../evil", steps: [{ block: "today" }] })).rejects.toThrow(ShortcutRefused);
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("lists the names of the user's shortcuts", async () => {
    lists = ["One\n  Two two \n\n"];
    expect(await installer().names()).toEqual(["One", "Two two"]);
  });
});

/**
 * The same, with nothing replaced: Apple signs the file, Shortcuts opens on
 * it, and whoever runs the test presses "Add Shortcut" within three minutes.
 * Sends a three-step shortcut to Apple and leaves it among the user's
 * shortcuts, so it runs only when asked for: VUNEMI_LIVE_SHORTCUTS=1.
 */
describe.skipIf(process.env.VUNEMI_LIVE_SHORTCUTS !== "1")("ShortcutInstaller, for real", () => {
  it("has a shortcut signed, sees the user add it, and the shortcut runs", async () => {
    const name = `Vunemi deneme ${String(Date.now()).slice(-5)}`;
    const built = await new ShortcutInstaller({ dir }).install({
      name,
      steps: [{ block: "today" }, { block: "formatDate", of: 1, style: "long" }, { block: "result", text: "{2}" }],
    });
    expect(built).toEqual({ state: "added", name });
    const out = join(dir, "out.txt");
    const run = () => promisify(execFile)("/usr/bin/shortcuts", ["run", name, "--output-path", out], { timeout: 45_000 });
    // Live, 10 Oct: the first run of a shortcut added a moment ago did not
    // come back within a minute; run again, it answered at once.
    await run().catch(run);
    // Today's date, written out: the year is in it whatever the language.
    expect(readFileSync(out, "utf8")).toContain(String(new Date().getFullYear()));
    // A second one by the same name is not built over it.
    expect(await new ShortcutInstaller({ dir }).install({ name, steps: [{ block: "today" }] })).toEqual({ state: "exists", name });
  }, 300_000);
});
