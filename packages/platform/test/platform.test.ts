import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { darwin, FEATURE_IDS, isPlatformId, linux, LINUX_DOWNLOAD_PAGE, platform, platformFor, platformInfo, RecycleRefused, windows, WINDOWS_DOWNLOAD_PAGE } from "../src/index.js";

describe("platform layer", () => {
  it("picks the implementation by Node's platform name", () => {
    expect(platformFor("darwin")).toBe(darwin);
    expect(platformFor("linux")).toBe(linux);
    // Anything else gets the one that assumes least.
    expect(platformFor("freebsd")).toBe(linux);
    expect(platform).toBe(platformFor(process.platform));
  });

  it("keeps every macOS feature on macOS", () => {
    for (const id of FEATURE_IDS) expect(darwin.features[id], id).toBe(true);
    expect(darwin.vaultKey).toBe("keychain-helper");
    expect(darwin.fileSearch).toBe("spotlight");
    expect(darwin.downloadPage).toBeNull();
  });

  it("keeps macOS's converters exactly as they were", () => {
    expect(darwin.systemRunPrograms).toEqual({
      sips: { path: "/usr/bin/sips", what: "convert and scale images" },
      textutil: { path: "/usr/bin/textutil", what: "convert document formats" },
      qlmanage: { path: "/usr/bin/qlmanage", what: "make preview images" },
      pdftotext: { path: "/opt/homebrew/bin/pdftotext", what: "extract text from PDFs" },
      ffmpeg: { path: "/opt/homebrew/bin/ffmpeg", what: "convert audio and video" },
    });
  });

  it("hides on Linux everything that needs macOS itself", () => {
    // Dictation works on Linux with its own whisper build; everything else here needs macOS.
    for (const id of FEATURE_IDS) expect(linux.features[id], id).toBe(id === "dictation");
    expect(linux.vaultKey).toBe("safe-storage");
    expect(linux.fileSearch).toBe("walk");
    expect(linux.downloadPage).toBe(LINUX_DOWNLOAD_PAGE);
  });

  it("offers on Linux only converters that cannot run a shell or fetch", () => {
    expect(Object.keys(linux.systemRunPrograms).sort()).toEqual(["ffmpeg", "pdftotext"]);
    for (const program of Object.values(linux.systemRunPrograms)) expect(program.path).toMatch(/^\/usr\/bin\//);
  });

  it("tells the window only data, never functions", () => {
    const info = platformInfo(linux);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    expect(Object.keys(info).sort()).toEqual(["downloadPage", "features", "id"]);
    // A copy: the window's view cannot change the process's flags.
    info.features.meetings = true;
    expect(linux.features.meetings).toBe(false);
  });
  it("picks Windows for win32 and still Linux for anything unknown", () => {
    expect(platformFor("win32")).toBe(windows);
    expect(platformFor("freebsd")).toBe(linux);
    expect(isPlatformId("win32")).toBe(true);
  });

  it("starts Windows with every macOS feature off but reading aloud, and nothing to run", () => {
    for (const id of FEATURE_IDS) expect(windows.features[id], id).toBe(id === "speakAloud" || id === "inAppUpdates");
    expect(windows.id).toBe("win32");
    expect(windows.vaultKey).toBe("safe-storage");
    expect(windows.fileSearch).toBe("walk");
    expect(windows.documentText).toBe("portable");
    expect(windows.systemRunPrograms).toEqual({});
    expect(windows.downloadPage).toBe(WINDOWS_DOWNLOAD_PAGE);
  });

  it("takes nothing back on Windows when the download is already gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-win-"));
    expect(() => windows.trashDownload(join(dir, "gone.txt"), "gone.txt")).not.toThrow();
  });

  // On Windows this would really use the Recycle Bin (windows-recycle.test.ts does, with a temp file).
  it.skipIf(process.platform === "win32")("refuses rather than deletes where there is no Recycle Bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-win-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "x");
    expect(() => windows.moveToTrash(file)).toThrow(RecycleRefused);
    expect(existsSync(file)).toBe(true);
  });
});
