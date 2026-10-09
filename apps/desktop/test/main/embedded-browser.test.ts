import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {}, WebContentsView: class {} }));
const { debuggerSession, newTabLoad } = await import("../../src/main/embedded-browser.js");

describe("a page opened into a new tab", () => {
  it("keeps a posted form's body and the page it came from", () => {
    const data = [{ type: "rawData" as const, bytes: Buffer.from("t=1&u=abc") }];
    expect(newTabLoad({ postBody: { contentType: "application/x-www-form-urlencoded", data }, referrer: "https://www.google.com/travel/flights/booking" }))
      .toEqual({ postData: data, extraHeaders: "Content-Type: application/x-www-form-urlencoded\n", httpReferrer: "https://www.google.com/travel/flights/booking" });
    expect(newTabLoad({ postBody: { contentType: "multipart/form-data", boundary: "XyZ", data } }).extraHeaders)
      .toBe("Content-Type: multipart/form-data; boundary=XyZ\n");
  });

  it("loads a plain link as it is", () => {
    expect(newTabLoad({})).toEqual({});
  });
});

describe("a tab's session over its debugger", () => {
  /** A debugger that records what it was sent and lets the test raise its events. */
  const channel = () => {
    const sent: [string, unknown, string | undefined][] = [];
    let raise: (e: unknown, method: string, params: unknown, sessionId?: string) => void = () => {};
    const s = debuggerSession({
      sendCommand: async (method, params, sessionId) => {
        sent.push([method, params, sessionId]);
        return { from: sessionId ?? "page" };
      },
      on: (_event, listener) => void (raise = listener),
    });
    return { s, sent, raise: (method: string, params: unknown, sessionId?: string) => raise({}, method, params, sessionId) };
  };

  it("sends the page's commands with no session id and a frame's with its own", async () => {
    const { s, sent } = channel();
    expect(await s.send("Page.enable")).toEqual({ from: "page" });
    const frame = s.child!("F1");
    expect(await frame.send("Accessibility.getFullAXTree", { depth: 2 })).toEqual({ from: "F1" });
    await frame.child!("F2").send("Page.getFrameTree");
    expect(sent).toEqual([
      ["Page.enable", {}, undefined],
      ["Accessibility.getFullAXTree", { depth: 2 }, "F1"],
      ["Page.getFrameTree", {}, "F2"],
    ]);
  });

  it("hands an event only to the session it came from, until that one stops listening", () => {
    const { s, raise } = channel();
    const got: string[] = [];
    s.on("Target.attachedToTarget", () => got.push("page"));
    const off = s.child!("F1").on("Target.attachedToTarget", () => got.push("F1"));
    raise("Target.attachedToTarget", {});
    raise("Target.attachedToTarget", {}, "F1");
    raise("Target.attachedToTarget", {}, "F9");
    raise("Page.frameNavigated", {}, "F1");
    expect(got).toEqual(["page", "F1"]);
    off();
    raise("Target.attachedToTarget", {}, "F1");
    expect(got).toEqual(["page", "F1"]);
  });
});
