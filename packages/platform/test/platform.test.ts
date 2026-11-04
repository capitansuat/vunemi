import { describe, expect, it } from "vitest";
import { darwin, FEATURE_IDS, linux, LINUX_DOWNLOAD_PAGE, platform, platformFor, platformInfo } from "../src/index.js";

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
    for (const id of FEATURE_IDS) expect(linux.features[id], id).toBe(false);
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
});
