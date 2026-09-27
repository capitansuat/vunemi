import { describe, expect, it, vi } from "vitest";
import { checkNavigation, isPrivateAddress, requestGuard } from "../src/url-policy.js";

describe("checkNavigation", () => {
  it.each(["https://example.com", "http://example.com/a?b=c#d", "https://www.google.com/search?q=x", "about:blank"])(
    "allows %s",
    (url) => expect(checkNavigation(url)).toBeNull(),
  );

  it.each([
    ["file:///etc/passwd", /file: URLs/],
    ["FILE:///etc/passwd", /file: URLs/],
    ["fi\tle:///etc/passwd", /file: URLs/], // tab stripped by the URL parser, still caught
    ["javascript:alert(1)", /javascript: URLs/],
    ["data:text/html,<script>", /data: URLs/],
    ["chrome://settings", /chrome: URLs/],
    ["chrome-extension://abc/popup.html", /chrome-extension: URLs/],
    ["http://localhost:5173", /localhost is blocked/],
    ["http://LOCALHOST./", /localhost is blocked/],
    ["http://127.0.0.1:9222/json", /127\.0\.0\.1 is blocked/],
    ["http://127.1/", /127\.0\.0\.1 is blocked/],
    ["http://0x7f000001/", /127\.0\.0\.1 is blocked/],
    ["http://2130706433/", /127\.0\.0\.1 is blocked/],
    ["http://10.0.0.5/admin", /blocked/],
    ["http://192.168.1.1/", /blocked/],
    ["http://172.20.0.1/", /blocked/],
    ["http://169.254.169.254/latest/meta-data", /blocked/],
    ["http://0.0.0.0:8080", /blocked/],
    ["http://[::1]:3000/", /\[::1\] is blocked/],
    ["http://[::ffff:127.0.0.1]/", /blocked/],
    ["http://[fd00::1]/", /blocked/],
    ["http://printer.local/", /blocked/],
    ["https://user:pass@example.com", /embedded credentials/],
    ["example.com", /not a valid absolute URL/],
  ])("blocks %s", (url, reason) => {
    expect(checkNavigation(url)).toMatch(reason);
  });

  it("does not mistake public hosts for private ones", () => {
    expect(checkNavigation("http://172.32.0.1/")).toBeNull();
    expect(checkNavigation("http://11.0.0.1/")).toBeNull();
    expect(checkNavigation("https://localhost-news.com")).toBeNull();
  });
});

describe("requestGuard", () => {
  const dns: Record<string, string[]> = {
    "example.com": ["93.184.216.34", "2606:2800:220:1::"],
    "rebind.test": ["93.184.216.34", "127.0.0.1"],
    "router.test": ["192.168.1.1"],
    "v6home.test": ["::ffff:10.0.0.2"],
  };
  const lookup = vi.fn(async (host: string) => {
    const found = dns[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  });

  it("refuses what a page reaches for on its own: a redirect, a frame, a fetch or a socket to this Mac or the LAN", async () => {
    const guard = requestGuard(lookup);
    expect(await guard("https://example.com/page")).toBeNull();
    expect(await guard("http://127.0.0.1:9333/json")).toMatch(/blocked/);
    expect(await guard("ws://localhost:5173/")).toMatch(/localhost is blocked/);
    expect(await guard("https://rebind.test/")).toMatch(/rebind\.test points to a private or loopback address \(127\.0\.0\.1\)/);
    expect(await guard("http://router.test/admin")).toMatch(/192\.168\.1\.1/);
    expect(await guard("http://v6home.test/")).toMatch(/blocked/);
    // The page's own data isn't the network; a name that doesn't resolve fails by itself.
    expect(await guard("data:text/plain,hi")).toBeNull();
    expect(await guard("blob:https://example.com/1")).toBeNull();
    expect(await guard("https://nowhere.test/")).toBeNull();
  });

  it("asks the resolver once per host while its answer is fresh", async () => {
    lookup.mockClear();
    const guard = requestGuard(lookup, 60_000);
    await Promise.all([guard("https://example.com/a"), guard("https://example.com/b"), guard("https://EXAMPLE.com./c")]);
    expect(lookup).toHaveBeenCalledTimes(1);
    const stale = requestGuard(lookup, 0);
    await stale("https://example.com/a");
    await stale("https://example.com/b");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("knows private addresses as a resolver writes them", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "::1", "fe80::1%en0", "fd12::3", "::ffff:192.168.0.1", "::ffff:7f00:1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "2606:2800:220:1::", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});
