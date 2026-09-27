import { describe, expect, it } from "vitest";
import { isLocalTestBuild, remoteDebugging, scrubEnv, shouldOfferMove } from "../../src/main/hardening.js";

describe("scrubEnv", () => {
  it("removes what could load code into Vunemi or the programs it starts", () => {
    const env: NodeJS.ProcessEnv = {
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      DYLD_LIBRARY_PATH: "/tmp",
      LD_PRELOAD: "/tmp/evil.so",
      NODE_OPTIONS: "--require /tmp/evil.js",
      ELECTRON_RUN_AS_NODE: "1",
      HOME: "/Users/me",
      PATH: "/usr/bin",
      LANG: "tr_TR.UTF-8",
    };
    expect(scrubEnv(env).sort()).toEqual(["DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE", "LD_PRELOAD", "NODE_OPTIONS"]);
    expect(env).toEqual({ HOME: "/Users/me", PATH: "/usr/bin", LANG: "tr_TR.UTF-8" });
  });

  it("leaves a clean environment alone", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/Users/me" };
    expect(scrubEnv(env)).toEqual([]);
    expect(env).toEqual({ HOME: "/Users/me" });
  });
});

describe("remote debugging", () => {
  it("is noticed however the switch is written", () => {
    expect(remoteDebugging(["Vunemi", "--remote-debugging-port=9333"])).toBe(true);
    expect(remoteDebugging(["Vunemi", "--remote-debugging-port", "9333"])).toBe(true);
    expect(remoteDebugging(["Vunemi", "--remote-debugging-pipe"])).toBe(true);
    expect(remoteDebugging(["Vunemi", "--remote-debugging-portal"])).toBe(false);
    expect(remoteDebugging(["Vunemi"])).toBe(false);
  });

  it("is allowed only by a build that says it is a local test build", () => {
    expect(isLocalTestBuild(JSON.stringify({ name: "@ocak/desktop", tenamiLocalTestBuild: true }))).toBe(true);
    expect(isLocalTestBuild(JSON.stringify({ name: "@ocak/desktop" }))).toBe(false);
    expect(isLocalTestBuild(JSON.stringify({ tenamiLocalTestBuild: "true" }))).toBe(true);
    expect(isLocalTestBuild(JSON.stringify({ tenamiLocalTestBuild: "yes" }))).toBe(false);
    expect(isLocalTestBuild("not json")).toBe(false);
  });
});

describe("shouldOfferMove", () => {
  // Live, 27 Sep: opened from the disk image, nothing said it belongs in Applications.
  const base = { packaged: true, platform: "darwin", inApplications: false, testBuild: false };
  it("offers only for a build for other people, run from outside Applications", () => {
    expect(shouldOfferMove(base)).toBe(true);
    expect(shouldOfferMove({ ...base, inApplications: true })).toBe(false);
    expect(shouldOfferMove({ ...base, testBuild: true })).toBe(false);
    expect(shouldOfferMove({ ...base, packaged: false })).toBe(false);
    expect(shouldOfferMove({ ...base, platform: "win32" })).toBe(false);
  });
});

