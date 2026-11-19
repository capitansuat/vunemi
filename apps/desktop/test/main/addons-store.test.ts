/**
 * Add-ons: programs Vunemi does not carry, fetched when the user asks. What
 * is worth testing is what this side decides: that only the pinned file is
 * installed, that a program signed by someone else is refused, and that
 * nothing half-installed is ever reported as ready.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DownloadError, type PinnedFile } from "../../src/main/engine/download.js";
import { ADDONS, addonUrl, allowedAddonUrl, type AddonSource } from "../../src/main/addons/catalog.js";
import { Addons, type AddonStatus } from "../../src/main/addons/store.js";

const GRID: AddonSource = {
  id: "sheets",
  category: "office",
  engine: "GridCraft",
  publisher: "ArtCraft",
  licence: "MIT OR Apache-2.0",
  repo: "storytold/gridcraft",
  tag: "v9.9.9",
  shelf: "addons-9",
  file: "gridcraft-cli-9.9.9-macos-universal.zip",
  folder: "gridcraft-cli-9.9.9-macos-universal",
  binary: "gridcraft-cli",
  size: 1000,
  sha256: "a".repeat(64),
};

let dir = "";
let asked: PinnedFile[] = [];
let trashed: string[] = [];
let seen: AddonStatus[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-addons-"));
  asked = [];
  trashed = [];
  seen = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Stands in for the network and for ditto: a zip is an empty file, unpacking writes the program. */
function addons(over: Partial<ConstructorParameters<typeof Addons>[0]> = {}): Addons {
  return new Addons({
    dir,
    catalog: [GRID],
    download: async (src, into) => {
      asked.push(src);
      mkdirSync(into, { recursive: true });
      const zip = join(into, src.name);
      writeFileSync(zip, "");
      return zip;
    },
    unpack: async (_zip, into) => {
      mkdirSync(join(into, GRID.folder), { recursive: true });
      writeFileSync(join(into, GRID.folder, GRID.binary), "#!/bin/sh\n");
    },
    signedBy: async () => "DJ6XS33FX8",
    trash: async (path) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    onChange: (_id, status) => seen.push(status),
    ...over,
  });
}

describe("add-ons", () => {
  it("installs the pinned file, says so as it goes, and gives the program's path", async () => {
    const a = addons();
    expect(a.status("sheets")).toEqual({ state: "absent" });
    expect(a.binary("sheets")).toBeNull();

    expect(await a.install("sheets")).toEqual({ state: "ready", version: "9.9.9" });
    expect(asked).toEqual([{ url: "https://github.com/capitansuat/vunemi/releases/download/addons-9/gridcraft-cli-9.9.9-macos-universal.zip", name: GRID.file, size: 1000, sha256: GRID.sha256 }]);
    expect(a.binary("sheets")).toBe(join(dir, "sheets", "v9.9.9", GRID.folder, GRID.binary));
    expect(seen.map((s) => s.state)).toEqual(["downloading", "installing", "ready"]);
    // The zip is not kept.
    expect(readdirSync(join(dir, ".incoming"))).toEqual([]);
    // A second request has nothing to do.
    await a.install("sheets");
    expect(asked).toHaveLength(1);
  });

  it("refuses a program signed by someone else, and leaves nothing behind", async () => {
    const a = addons({ signedBy: async () => "EVIL000000" });
    expect(await a.install("sheets")).toEqual({ state: "failed", reason: "signature" });
    expect(a.binary("sheets")).toBeNull();
    expect(existsSync(join(dir, "sheets"))).toBe(false);
  });

  it("names why a download failed, and can be tried again", async () => {
    let fail = true;
    const a = addons({
      download: async (src, into) => {
        if (fail) throw new DownloadError("integrity", "The downloaded file does not match its checksum");
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, src.name), "");
        return join(into, src.name);
      },
    });
    expect(await a.install("sheets")).toEqual({ state: "failed", reason: "integrity" });
    fail = false;
    expect(await a.install("sheets")).toEqual({ state: "ready", version: "9.9.9" });
  });

  it("goes back to absent when the download is cancelled", async () => {
    const a = addons({
      download: (_src, _into, opts) =>
        new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new DownloadError("cancelled", "Cancelled")))),
    });
    const running = a.install("sheets");
    expect(a.status("sheets").state).toBe("downloading");
    a.cancel("sheets");
    expect(await running).toEqual({ state: "absent" });
  });

  it("calls an older installed version outdated, and replaces it on install", async () => {
    const old = join(dir, "sheets", "v9.9.8", "gridcraft-cli-9.9.8-macos-universal");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, GRID.binary), "");
    const a = addons();
    expect(a.status("sheets")).toEqual({ state: "outdated", version: "9.9.8" });
    // An older program is not handed out: the tools were written against the pinned one.
    expect(a.binary("sheets")).toBeNull();
    await a.install("sheets");
    expect(readdirSync(join(dir, "sheets"))).toEqual(["v9.9.9"]);
  });

  it("updates on opening only the add-ons the user has, keeping the old version until the new one is checked", async () => {
    const PHOTO: AddonSource = { ...GRID, id: "photo", engine: "PhotoCraft", repo: "storytold/photocraft" };
    const old = join(dir, "sheets", "v9.9.8", "gridcraft-cli-9.9.8-macos-universal");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, GRID.binary), "");
    let oldThere: boolean[] = [];
    const a = addons({
      catalog: [GRID, PHOTO],
      signedBy: async () => {
        oldThere.push(existsSync(old));
        return "DJ6XS33FX8";
      },
    });
    expect(a.updating("sheets")).toBe(true);
    expect(a.updating("photo")).toBe(false);
    await a.updateOutdated();
    // Only the add-on that was installed is downloaded; the other stays absent.
    expect(asked.map((f) => f.name)).toEqual([GRID.file]);
    expect(a.status("photo")).toEqual({ state: "absent" });
    expect(a.status("sheets")).toEqual({ state: "ready", version: "9.9.9" });
    expect(a.updating("sheets")).toBe(false);
    expect(oldThere).toEqual([true]);
    expect(seen.slice(0, 2)).toEqual([{ state: "downloading", received: 0, from: "9.9.8" }, { state: "installing", from: "9.9.8" }]);
    expect(readdirSync(join(dir, "sheets"))).toEqual(["v9.9.9"]);
    // Nothing is left to update.
    oldThere = [];
    await a.updateOutdated();
    expect(asked).toHaveLength(1);
  });

  it("keeps the old version when an update fails, says it was an update, and tries again on the next opening", async () => {
    const old = join(dir, "sheets", "v9.9.8", "gridcraft-cli-9.9.8-macos-universal");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, GRID.binary), "");
    const failing = addons({ download: async () => { throw new DownloadError("network", "Offline"); } });
    await failing.updateOutdated();
    expect(failing.status("sheets")).toEqual({ state: "failed", reason: "network", from: "9.9.8" });
    expect(failing.updating("sheets")).toBe(true);
    expect(existsSync(join(old, GRID.binary))).toBe(true);
    // Vunemi opens again, now online.
    const next = addons();
    expect(next.status("sheets")).toEqual({ state: "outdated", version: "9.9.8" });
    await next.updateOutdated();
    expect(next.status("sheets")).toEqual({ state: "ready", version: "9.9.9" });
  });

  it("removes an add-on to the Trash", async () => {
    const a = addons();
    await a.install("sheets");
    expect(await a.remove("sheets")).toEqual({ state: "absent" });
    expect(trashed).toEqual([join(dir, "sheets")]);
    expect(a.binary("sheets")).toBeNull();
  });

  it("lists every add-on with its size and where it comes from", () => {
    expect(addons().list()).toEqual([{ id: "sheets", category: "office", engine: "GridCraft", publisher: "ArtCraft", licence: "MIT OR Apache-2.0", version: "9.9.9", bytes: 1000, source: "https://github.com/storytold/gridcraft", status: { state: "absent" } }]);
  });
});

describe("the add-on catalogue", () => {
  it("pins every file by size and SHA-256, under the folder its name gives", () => {
    expect(ADDONS.length).toBeGreaterThan(0);
    for (const a of ADDONS) {
      expect(a.sha256, a.id).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size, a.id).toBeGreaterThan(1_000_000);
      expect(a.file, a.id).toBe(`${a.folder}.zip`);
      expect(a.file, a.id).toContain(a.tag.slice(1));
      // Vunemi's own copy, never the project's release page.
      expect(dirname(addonUrl(a)), a.id).toBe(`https://github.com/capitansuat/vunemi/releases/download/${a.shelf}`);
    }
    expect(new Set(ADDONS.map((a) => a.id)).size).toBe(ADDONS.length);
  });

  it("downloads only from GitHub and where GitHub keeps release files", () => {
    const ok = (u: string) => allowedAddonUrl(new URL(u));
    expect(ok("https://github.com/capitansuat/vunemi/releases/download/addons-1/x.zip")).toBe(true);
    expect(ok("https://release-assets.githubusercontent.com/github-production-release-asset/1/x")).toBe(true);
    expect(ok("https://objects.githubusercontent.com/x")).toBe(true);
    expect(ok("http://github.com/storytold/gridcraft/releases/download/v0.5.0/x.zip")).toBe(false);
    expect(ok("https://github.com.evil.example/x.zip")).toBe(false);
    expect(ok("https://evilgithubusercontent.com/x.zip")).toBe(false);
  });
});
