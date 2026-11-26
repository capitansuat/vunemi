/** An AppImage replaces itself with the signed update, and only itself. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { installableAppImage, LinuxAppImageUpdater, restartCommand } from "../../src/main/updates/linux-updater.js";

const OLD = "the running appimage";
const BYTES = "made-up appimage 0.5.1";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const URL_ = "https://github.com/capitansuat/vunemi/releases/download/v0.5.1-linux.1/Vunemi-0.5.1-linux-x86_64.AppImage";
const offer = { version: "0.5.1", notes: [], sizeMb: null, url: URL_, sha256: SHA };

let dir = "";
let appImage = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-linupd-"));
  appImage = join(dir, "Vunemi.AppImage");
  writeFileSync(appImage, OLD, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function updater(bytes = BYTES) {
  const restarted: string[] = [];
  let quit = 0;
  const events: string[] = [];
  const u = new LinuxAppImageUpdater({
    appImage,
    download: async (_url, file) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(file, bytes);
    },
    restart: (file) => restarted.push(file),
    quit: () => { quit++; },
  });
  u.on("update-downloaded", () => events.push("downloaded"));
  u.on("error", (err) => events.push(`error:${err.message}`));
  return { u, restarted, events, quits: () => quit };
}
const ended = (events: string[]) => vi.waitFor(() => expect(events).not.toHaveLength(0), { timeout: 5_000 });
const besides = () => readdirSync(dir).sort();

describe("the AppImage updater", () => {
  it("downloads beside the AppImage, keeps it only when it is the signed file, and replaces itself only when asked", async () => {
    const { u, restarted, events, quits } = updater();
    u.prepare(offer);
    u.checkForUpdates();
    await ended(events);
    expect(events).toEqual(["downloaded"]);
    expect(readFileSync(appImage, "utf8")).toBe(OLD);
    expect(await u.stagedMatches()).toBe(true);
    u.quitAndInstall();
    expect(readFileSync(appImage, "utf8")).toBe(BYTES);
    if (process.platform !== "win32") expect(statSync(appImage).mode & 0o777).toBe(0o755);
    expect(besides()).toEqual(["Vunemi.AppImage"]);
    expect(restarted).toEqual([appImage]);
    expect(quits()).toBe(1);
  });

  it("throws away a download that isn't the signed file, and leaves the AppImage alone", async () => {
    const { u, restarted, events } = updater("something else");
    u.prepare(offer);
    u.checkForUpdates();
    await ended(events);
    expect(events[0]).toMatch(/^error:/);
    expect(besides()).toEqual(["Vunemi.AppImage"]);
    expect(await u.stagedMatches()).toBeNull();
    u.quitAndInstall();
    expect(readFileSync(appImage, "utf8")).toBe(OLD);
    expect(restarted).toEqual([]);
  });

  it("refuses a staged file changed after it was checked", async () => {
    const { u, restarted, events } = updater();
    u.prepare(offer);
    u.checkForUpdates();
    await ended(events);
    const staged = besides().find((name) => name !== "Vunemi.AppImage")!;
    writeFileSync(join(dir, staged), "changed after the check");
    expect(await u.stagedMatches()).toBe(false);
    u.quitAndInstall();
    expect(readFileSync(appImage, "utf8")).toBe(OLD);
    expect(restarted).toEqual([]);
  });

  it("fetches nothing for an offer without a signed file", async () => {
    const { u, events } = updater();
    u.prepare({ version: "0.5.1", notes: [], sizeMb: null });
    u.checkForUpdates();
    await ended(events);
    expect(events[0]).toMatch(/^error:/);
    expect(besides()).toEqual(["Vunemi.AppImage"]);
  });

  it("at start removes only its own leftovers beside the AppImage", () => {
    for (const name of [".Vunemi-0.5.1.AppImage.part", ".Vunemi-0.5.1.AppImage.new", "notes.txt", "Other.AppImage", ".other.part"]) writeFileSync(join(dir, name), "x");
    updater().u.forgetOld();
    expect(besides()).toEqual([".other.part", "Other.AppImage", "Vunemi.AppImage", "notes.txt"]);
  });
});

describe("which AppImage may be replaced", () => {
  const mount = "/tmp/.mount_VunemiAbc123";
  const exec = `${mount}/vunemi`;
  const env = () => ({ APPIMAGE: appImage, APPDIR: mount });
  const writable = () => true;

  it("is the running AppImage when Vunemi runs from inside it and its folder is writable", () => {
    expect(installableAppImage(env(), exec, true, writable)).toBe(appImage);
  });

  it("is none for a .deb, a development run, or another program's AppImage inherited from a shell", () => {
    expect(installableAppImage({}, "/opt/Vunemi/vunemi", true, writable)).toBeNull();
    expect(installableAppImage(env(), exec, false, writable)).toBeNull();
    // A .deb started from another AppImage's terminal inherits that program's APPIMAGE and APPDIR.
    expect(installableAppImage(env(), "/opt/Vunemi/vunemi", true, writable)).toBeNull();
    expect(installableAppImage({ APPIMAGE: appImage, APPDIR: `${mount}-other` }, exec, true, writable)).toBeNull();
  });

  it("is none for a relative path, a folder, a link or a missing file", () => {
    expect(installableAppImage({ APPIMAGE: "Vunemi.AppImage", APPDIR: mount }, exec, true, writable)).toBeNull();
    mkdirSync(join(dir, "folder.AppImage"));
    expect(installableAppImage({ APPIMAGE: join(dir, "folder.AppImage"), APPDIR: mount }, exec, true, writable)).toBeNull();
    const link = join(dir, "link.AppImage");
    symlinkSync(appImage, link);
    expect(installableAppImage({ APPIMAGE: link, APPDIR: mount }, exec, true, writable)).toBeNull();
    expect(installableAppImage({ APPIMAGE: join(dir, "gone.AppImage"), APPDIR: mount }, exec, true, writable)).toBeNull();
  });

  it("is none where its folder can't be written, as under /opt", () => {
    expect(installableAppImage(env(), exec, true, () => false)).toBeNull();
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(dir, 0o555);
      try {
        expect(installableAppImage(env(), exec, true)).toBeNull();
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(installableAppImage(env(), exec, true)).toBe(appImage);
    }
    expect(existsSync(appImage)).toBe(true);
  });
});

describe("the restart step", () => {
  // Linux only: it reads /proc. The new AppImage must not get this process's open files,
  // or the replaced image stays mounted (its keep-alive pipe) for as long as the new one runs.
  const linux = process.platform === "linux";
  for (const bash of [true, false]) {
    it.skipIf(!linux)(`waits for the old process and passes on no open files (${bash ? "bash" : "sh"})`, async () => {
      const out = join(dir, "fds.txt");
      const probe = join(dir, "probe.sh");
      writeFileSync(probe, `#!/bin/sh\nfor f in /proc/$$/fd/*; do echo "\${f##*/} $(readlink "$f")"; done > "${out}"\n`, { mode: 0o755 });
      const gone = spawn("true");
      await new Promise((resolve) => gone.on("exit", resolve));
      const held = openSync(appImage, "r");
      const [cmd, args] = restartCommand(gone.pid!, probe, bash);
      const stdio = Array.from({ length: 13 }, (_, i) => (i === 3 || i === 12 ? held : "ignore"));
      const step = spawn(cmd, args, { stdio: stdio as never });
      await new Promise((resolve) => step.on("exit", resolve));
      closeSync(held);
      await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 5_000 });
      // Which of the probe's descriptors still point at the file this test held open.
      const handed = readFileSync(out, "utf8").split("\n").filter((line) => line.endsWith(` ${appImage}`)).map((line) => Number(line.split(" ")[0]));
      // sh (dash) can only close 3 to 9, where the runtime's pipe arrives; bash closes everything above stderr.
      expect(handed).toEqual(bash ? [] : [12]);
    });
  }
});
