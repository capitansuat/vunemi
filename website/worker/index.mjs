const categories = new Set(["bug", "idea", "question"]);
const allowedHosts = new Set(["vunemi.com", "www.vunemi.com"]);

function json(status, code) {
  return new Response(JSON.stringify({ ok: status === 200, code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readSmallBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function submitSupport(request, env) {
  if (request.method !== "POST") return json(405, "method_not_allowed");
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!allowedHosts.has(url.hostname) || origin !== url.origin) return json(403, "invalid_origin");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(415, "invalid_type");
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return json(413, "too_large");
  if (!env.TURNSTILE_SECRET || !env.SUPPORT_EMAIL || !env.SUPPORT_RATE) return json(503, "unavailable");

  let raw;
  try { raw = await readSmallBody(request); } catch { return json(400, "invalid_fields"); }
  if (raw === null) return json(413, "too_large");
  const form = new URLSearchParams(raw);
  if (form.get("website")) return json(200, "accepted");
  const category = form.get("category") || "";
  const message = (form.get("message") || "").trim();
  const version = (form.get("version") || "").trim();
  const language = (form.get("language") || "").trim();
  const token = form.get("cf-turnstile-response") || "";
  if (!categories.has(category) || message.length < 10 || message.length > 2000 || version.length > 80 || !/^[a-z]{2}$/.test(language) || !token || token.length > 2048) return json(400, "invalid_fields");

  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return json(503, "unavailable");
  const limit = await env.SUPPORT_RATE.limit({ key: ip });
  if (!limit.success) return json(429, "rate_limited");

  let challenge;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    challenge = await response.json();
  } catch {
    return json(503, "verification_unavailable");
  }
  if (!challenge.success || !allowedHosts.has(challenge.hostname)) return json(403, "verification_failed");

  const id = crypto.randomUUID().slice(0, 8);
  try {
    await env.SUPPORT_EMAIL.send({
      to: "support@vunemi.com",
      from: "form@vunemi.com",
      subject: `[Vunemi support] ${category} #${id}`,
      text: `Reference: ${id}\nCategory: ${category}\nApp version: ${version || "unspecified"}\nPage language: ${language}\n\nMessage:\n${message}\n`,
    });
  } catch {
    return json(503, "delivery_failed");
  }
  return json(200, "accepted");
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/support") return submitSupport(request, env);
    return env.ASSETS.fetch(request);
  },
};
