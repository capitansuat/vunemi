import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "node:http";
import { authorizeOutlook, outlookTokenSource } from "../../src/main/outlook-oauth.js";

afterEach(() => vi.unstubAllGlobals());

describe("Outlook refresh tokens", () => {
  it.skipIf(!process.env.OCAK_LIVE_LOOPBACK_TEST)("accepts only the matching loopback state and exchanges a PKCE code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = options.body as URLSearchParams;
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    const result = await authorizeOutlook("12345678-1234-1234-1234-123456789abc", async (url) => {
      const auth = new URL(url);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      const redirect = new URL(auth.searchParams.get("redirect_uri")!);
      redirect.hostname = "127.0.0.1";
      redirect.searchParams.set("state", auth.searchParams.get("state")!);
      redirect.searchParams.set("code", "auth-code");
      await new Promise<void>((resolve, reject) => get(redirect, (response) => {
        response.resume();
        response.on("end", resolve);
      }).on("error", reject));
    }, 5_000);
    expect(result.refreshToken).toBe("refresh");
  });

  it("refreshes once for concurrent requests and stores a rotated token", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const fields = options.body as URLSearchParams;
      expect(fields.get("refresh_token")).toBe("old-refresh");
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    let refresh = "old-refresh";
    const source = outlookTokenSource("12345678-1234-1234-1234-123456789abc", () => refresh, (next) => { refresh = next; });
    expect(await Promise.all([source(), source()])).toEqual(["new-access", "new-access"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refresh).toBe("new-refresh");
    expect(await source()).toBe("new-access");
  });

  it("rejects an invalid application id before opening sign-in", () => {
    expect(() => outlookTokenSource("not-an-id", () => "x", () => {})).toThrow(/kimliği geçersiz/);
  });
});
