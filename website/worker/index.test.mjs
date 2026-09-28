import assert from "node:assert/strict";
import { test } from "node:test";
import { submitSupport } from "./index.mjs";

const data = new URLSearchParams({ category: "bug", message: "The test button did nothing.", version: "0.1.1", language: "en", "cf-turnstile-response": "test-token" });
const request = (body = data, origin = "https://vunemi.com") => new Request("https://vunemi.com/api/support", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "192.0.2.1" }, body });
const env = (send) => ({ TURNSTILE_SECRET: "test-secret", SUPPORT_RATE: { limit: async () => ({ success: true }) }, SUPPORT_EMAIL: { send } });

test("rejects a cross-origin submission before sending", async () => {
  const response = await submitSupport(request(data, "https://example.com"), env(() => { throw new Error("sent"); }));
  assert.equal(response.status, 403);
});

test("rejects malformed fields and missing challenge", async () => {
  const response = await submitSupport(request(new URLSearchParams({ category: "bug", message: "short" })), env(() => { throw new Error("sent"); }));
  assert.equal(response.status, 400);
});

test("rejects an oversized body before verification", async () => {
  const oversized = new URLSearchParams({ category: "bug", message: "x".repeat(9000), language: "en", "cf-turnstile-response": "test-token" });
  const response = await submitSupport(request(oversized), env(() => { throw new Error("sent"); }));
  assert.equal(response.status, 413);
});

test("rejects the rate limit before verification", async () => {
  const limited = env(() => { throw new Error("sent"); });
  limited.SUPPORT_RATE.limit = async () => ({ success: false });
  const response = await submitSupport(request(), limited);
  assert.equal(response.status, 429);
});

test("a verified submission sends only to the support routing address", async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: "vunemi.com" }), { status: 200 });
  let sent;
  const response = await submitSupport(request(), env(async (message) => { sent = message; return { messageId: "test" }; }));
  assert.equal(response.status, 200);
  assert.equal(sent.to, "support@vunemi.com");
  assert.equal(sent.from, "form@vunemi.com");
  assert.equal(sent.replyTo, undefined);
  assert.match(sent.text, /The test button did nothing/);
});

test("does not claim delivery when the email service fails", async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: "vunemi.com" }), { status: 200 });
  const response = await submitSupport(request(), env(async () => { throw new Error("delivery failed"); }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "delivery_failed");
});
