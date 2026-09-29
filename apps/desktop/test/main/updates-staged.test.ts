import { describe, expect, it } from "vitest";
import { stagedMatches, type Run } from "../../src/main/updates/staged.js";

const REQ = 'designated => identifier "com.vunemi.app" and certificate leaf = H"abc"';

function fake(state: object | null, opts: { verifyFails?: boolean; stagedReq?: string } = {}): Run {
  return async (cmd, args) => {
    if (cmd === "plutil") {
      if (!state) throw new Error("no such file");
      return JSON.stringify(state);
    }
    if (args[0] === "--verify") {
      if (opts.verifyFails) throw new Error("invalid signature");
      return "";
    }
    return args.at(-1) === "/Applications/Vunemi.app" ? `${REQ}\n` : `${opts.stagedReq ?? REQ}\n`;
  };
}

const STATE = { updateBundleURL: "file:///Users/x/Library/Caches/com.vunemi.app.ShipIt/update.abc/Vunemi.app/" };

describe("stagedMatches", () => {
  it("accepts a staged app signed like the running one", async () => {
    expect(await stagedMatches(fake(STATE), "/state.plist", "/Applications/Vunemi.app")).toBe(true);
  });
  it("refuses a staged app that fails verification or is signed by someone else", async () => {
    expect(await stagedMatches(fake(STATE, { verifyFails: true }), "/state.plist", "/Applications/Vunemi.app")).toBe(false);
    expect(await stagedMatches(fake(STATE, { stagedReq: 'designated => identifier "com.vunemi.app" and certificate leaf = H"evil"' }), "/state.plist", "/Applications/Vunemi.app")).toBe(false);
  });
  it("cannot tell without Squirrel's state", async () => {
    expect(await stagedMatches(fake(null), "/state.plist", "/Applications/Vunemi.app")).toBeNull();
    expect(await stagedMatches(fake({}), "/state.plist", "/Applications/Vunemi.app")).toBeNull();
  });
});
