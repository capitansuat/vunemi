import { get } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailProviderOptions } from "../../src/main/connectors.js";
import { authorizeGoogle, googleAddress, googleTokenSource } from "../../src/main/google-oauth.js";

afterEach(() => vi.unstubAllGlobals());

const client = { clientId: "1234-abcdef.apps.googleusercontent.com", clientSecret: "GOCSPX-synthetic" };
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("Gmail sign-in with Google", () => {
  it.skipIf(!process.env.VUNEMI_LIVE_LOOPBACK_TEST)("asks for offline access on 127.0.0.1 and sends the desktop client secret with the PKCE code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const body = options.body as URLSearchParams;
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("client_secret")).toBe("GOCSPX-synthetic");
      return new Response(JSON.stringify({ access_token: "ya29.a", refresh_token: "1//r", expires_in: 3600, id_token: idToken({ email: "me@gmail.com", email_verified: true }) }), { status: 200 });
    }));
    const tokens = await authorizeGoogle(client, async (url) => {
      const auth = new URL(url);
      expect(auth.origin).toBe("https://accounts.google.com");
      expect(auth.searchParams.get("access_type")).toBe("offline");
      expect(auth.searchParams.get("scope")).toContain("https://mail.google.com/");
      const redirect = new URL(auth.searchParams.get("redirect_uri")!);
      expect(redirect.hostname).toBe("127.0.0.1");
      redirect.searchParams.set("state", auth.searchParams.get("state")!);
      redirect.searchParams.set("code", "auth-code");
      await new Promise<void>((resolve, reject) => get(redirect, (response) => { response.resume(); response.on("end", resolve); }).on("error", reject));
    }, 5_000);
    expect(tokens.refreshToken).toBe("1//r");
    expect(googleAddress(tokens)).toBe("me@gmail.com");
  });

  it("takes the address from Google's own token, and refuses an unverified one", () => {
    const base = { accessToken: "a", refreshToken: "r", expiresAt: 0 };
    expect(googleAddress({ ...base, idToken: idToken({ email: "me@gmail.com", email_verified: true }) })).toBe("me@gmail.com");
    expect(() => googleAddress({ ...base, idToken: idToken({ email: "me@gmail.com", email_verified: false }) })).toThrow();
    expect(() => googleAddress(base)).toThrow();
  });

  it("refreshes an access token, keeping the refresh token when Google doesn't rotate it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      expect((options.body as URLSearchParams).get("refresh_token")).toBe("1//old");
      return new Response(JSON.stringify({ access_token: "ya29.new", expires_in: 3600 }), { status: 200 });
    }));
    const saved: string[] = [];
    const source = googleTokenSource(client, () => "1//old", (next) => saved.push(next));
    expect(await source()).toBe("ya29.new");
    expect(saved).toEqual([]);
  });

  it("won't start without a proper registration", () => {
    expect(() => googleTokenSource({ clientId: "nope", clientSecret: "x" }, () => "", () => {})).toThrow();
    expect(() => googleTokenSource({ ...client, clientSecret: "" }, () => "", () => {})).toThrow();
  });

  it("offers Google and Microsoft sign-in only when the build has them", () => {
    expect(mailProviderOptions({}).map((p) => p.id)).toEqual(["gmail", "outlook", "imap"]);
    expect(mailProviderOptions({ google: client, microsoft: { clientId: "12345678-1234-1234-1234-123456789abc" } }).map((p) => p.id))
      .toEqual(["google", "microsoft", "gmail", "imap"]);
  });
});
