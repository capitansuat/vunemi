import { describe, expect, it } from "vitest";
import { closedFrame } from "../src/frames.js";

describe("closedFrame", () => {
  it("leaves a CAPTCHA's frame unread, wherever it is served from", () => {
    for (const url of [
      "https://www.google.com/recaptcha/api2/anchor?k=x",
      "https://www.google.com.tr/recaptcha/enterprise/bframe",
      "https://google.co.uk/recaptcha/api2/anchor",
      "https://www.recaptcha.net/recaptcha/api2/anchor",
      "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2",
      "https://client-api.arkoselabs.com/fc/gc/",
      "https://geo.captcha-delivery.com/captcha/",
    ]) expect(closedFrame(url), url).toBe("challenge");
  });

  it("skips a frame from a well-known ad host", () => {
    for (const url of [
      "https://googleads.g.doubleclick.net/pagead/ads?client=x",
      "https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html",
      "https://widgets.outbrain.com/widget.html",
    ]) expect(closedFrame(url), url).toBe("ad");
  });

  it("reads every other frame, a payment form or a map among them", () => {
    for (const url of [
      "https://js.stripe.com/v3/elements-inner-card.html",
      "https://www.google.com/maps/embed?pb=x",
      "https://accounts.google.com/gsi/iframe/select",
      "https://www.youtube.com/embed/abc",
      // A host that only ends like a listed one is another site.
      "https://nothcaptcha.com/",
      "https://google.evil.example/recaptcha/x",
    ]) expect(closedFrame(url), url).toBeNull();
  });

  it("reads a frame with no address of its own", () => {
    expect(closedFrame("about:blank")).toBeNull();
    expect(closedFrame("")).toBeNull();
  });
});
