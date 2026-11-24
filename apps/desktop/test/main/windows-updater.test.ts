/** Downloading and running a signed Windows installer, and nothing else. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installableOnWindows, WindowsUpdater } from "../../src/main/updates/windows-updater.js";

const BYTES = "made-up installer";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const URL_ = "https://github.com/capitansuat/vunemi/releases/download/v0.5.1/Vunemi-Setup-0.5.1-x64.exe";
const offer = { version: "0.5.1", notes: [], sizeMb: null, url: URL_, sha256: SHA };

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-winupd-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function updater(bytes = BYTES) {
  const spawned: { file: string; args: string[] }[] = [];
  let quit = 0;
  const events: string[] = [];
  const u = new WindowsUpdater({
    dir,
    arch: "x64",
    download: async (_url, file) => writeFileSync(file, bytes),
    spawn: (file, args) => spawned.push({ file, args }),
    quit: () => { quit++; },
  });
  u.on("update-downloaded", () => events.push("downloaded"));
  u.on("error", (err) => events.push(`error:${err.message}`));
  return { u, spawned, events, quits: () => quit };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the Windows updater", () => {
  it("downloads the offered installer, checks it, and runs it only when asked", async () => {
    const { u, spawned, events, quits } = updater();
    u.prepare(offer);
    u.checkForUpdates();
    await settle();
    expect(events).toEqual(["downloaded"]);
    expect(spawned).toEqual([]);
    expect(await u.stagedMatches()).toBe(true);
    u.quitAndInstall();
    expect(spawned).toEqual([{ file: join(dir, "Vunemi-Setup-0.5.1-x64.exe"), args: ["/S", "--updated", "--force-run"] }]);
    expect(quits()).toBe(1);
  });

  it("throws away an installer that isn't the one the feed signed", async () => {
    const { u, spawned, events } = updater("something else");
    u.prepare(offer);
    u.checkForUpdates();
    await settle();
    expect(events).toEqual([expect.stringMatching(/^error:/)]);
    expect(readdirSync(dir)).toEqual([]);
    u.quitAndInstall();
    expect(spawned).toEqual([]);
  });

  it("runs nothing before a checked download, or without a signed offer", async () => {
    const { u, spawned, quits } = updater();
    u.quitAndInstall();
    u.prepare({ version: "0.5.1", notes: [], sizeMb: null });
    u.checkForUpdates();
    await settle();
    u.quitAndInstall();
    expect(spawned).toEqual([]);
    expect(quits()).toBe(0);
  });

  it("notices an installer changed after it was checked", async () => {
    const { u, spawned } = updater();
    u.prepare(offer);
    u.checkForUpdates();
    await settle();
    writeFileSync(join(dir, "Vunemi-Setup-0.5.1-x64.exe"), "swapped");
    expect(await u.stagedMatches()).toBe(false);
    u.quitAndInstall();
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, "Vunemi-Setup-0.5.1-x64.exe"))).toBe(false);
  });
});

describe("where Vunemi can replace itself on Windows", () => {
  const home = "C:\\Users\\someone\\AppData\\Local\\Programs\\vunemi";
  it("only from the folder its installer recorded, in any letter case", () => {
    expect(installableOnWindows(`${home}\\Vunemi.exe`, home, true)).toBe(true);
    expect(installableOnWindows(`${home.toUpperCase()}\\VUNEMI.EXE`, home, true)).toBe(true);
  });

  it("not from a development run, an unpacked copy, another folder, or with nothing recorded", () => {
    expect(installableOnWindows(`${home}\\Vunemi.exe`, home, false)).toBe(false);
    expect(installableOnWindows("C:\\src\\vunemi\\node_modules\\electron\\dist\\electron.exe", home, true)).toBe(false);
    expect(installableOnWindows("C:\\build\\win-unpacked\\Vunemi.exe", home, true)).toBe(false);
    expect(installableOnWindows(`${home}-old\\Vunemi.exe`, home, true)).toBe(false);
    expect(installableOnWindows(`${home}\\Vunemi.exe`, null, true)).toBe(false);
    expect(installableOnWindows(`${home}\\..\\elsewhere\\Vunemi.exe`, home, true)).toBe(false);
    expect(installableOnWindows(`${home}/Vunemi.exe`, `${home}\\`, true)).toBe(true);
  });
});

describe("the installer's registry key", () => {
  it("is the one electron-builder makes from the app id (as the VM's install shows)", async () => {
    const { installerKey } = await import("../../src/main/updates/windows-updater.js");
    expect(installerKey("com.vunemi.app")).toBe("ac5ead42-ea2c-550d-b83a-3ac841979d9d");
  });
});
