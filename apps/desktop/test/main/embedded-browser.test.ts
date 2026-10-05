import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {}, WebContentsView: class {} }));
const { newTabLoad } = await import("../../src/main/embedded-browser.js");

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
