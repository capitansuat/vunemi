/**
 * Sign-in for a desktop app, the way Google and Microsoft both want it: the
 * user signs in in their own browser, a short-lived listener on 127.0.0.1
 * takes the code back, and state plus PKCE make sure the code is ours. Never
 * an embedded login page: Vunemi doesn't see the password.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { getLocale, t, type MessageKey } from "@ocak/i18n";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Google's OpenID token, when asked for; it names the account. */
  idToken?: string;
}

/** What a provider's sign-in says when it goes wrong, in its own words. */
export interface OAuthMessages {
  tokenFailed: MessageKey;
  noTokens: MessageKey;
  notCompleted: MessageKey;
  timeout: MessageKey;
}

export interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Google's desktop clients have one; it isn't a secret for an installed app, but it is required. */
  clientSecret?: string;
  scope: string;
  /** The host the provider was told to send the user back to. */
  redirectHost: "localhost" | "127.0.0.1";
  extraAuthParams?: Record<string, string>;
  messages: OAuthMessages;
}

async function tokenRequest(provider: OAuthProvider, fields: URLSearchParams): Promise<OAuthTokens> {
  if (provider.clientSecret) fields.set("client_secret", provider.clientSecret);
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(t(provider.messages.tokenFailed, { status: response.status }));
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") throw new Error(t(provider.messages.noTokens));
  return {
    accessToken: data.access_token,
    // A refresh may not rotate it; the caller keeps the one it has then.
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(typeof data.id_token === "string" && { idToken: data.id_token }),
  };
}

export async function authorize(provider: OAuthProvider, openBrowser: (url: string) => Promise<void>, timeoutMs = 300_000): Promise<OAuthTokens> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ocak") { res.writeHead(404).end(); return; }
    if (url.searchParams.get("state") !== state) { res.writeHead(400).end(t("main.outlook.badState")); return; }
    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("code");
    if (error || !returned) {
      res.writeHead(400).end(t("main.outlook.pageFailed"));
      rejectCode(new Error(t(provider.messages.notCompleted)));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" })
      .end(`<!doctype html><html lang='${getLocale()}'><meta charset='utf-8'><title>Vunemi</title><body>${escapeHtml(t("main.outlook.pageDone"))}</body></html>`);
    resolveCode(returned);
  });
  server.listen(0, "127.0.0.1");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error(t("main.outlook.noListener"));
    const redirect = `http://${provider.redirectHost}:${address.port}/ocak`;
    const url = new URL(provider.authUrl);
    for (const [key, value] of Object.entries({
      client_id: provider.clientId, response_type: "code", redirect_uri: redirect,
      scope: provider.scope, state, code_challenge: challenge, code_challenge_method: "S256",
      ...provider.extraAuthParams,
    })) url.searchParams.set(key, value);
    await openBrowser(url.toString());
    const authorizationCode = await Promise.race([
      code,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(t(provider.messages.timeout))), timeoutMs); }),
    ]);
    const tokens = await tokenRequest(provider, new URLSearchParams({
      client_id: provider.clientId, grant_type: "authorization_code", code: authorizationCode,
      redirect_uri: redirect, code_verifier: verifier, scope: provider.scope,
    }));
    if (!tokens.refreshToken) throw new Error(t(provider.messages.noTokens));
    return tokens;
  } finally {
    if (timeout) clearTimeout(timeout);
    server.close();
  }
}

/**
 * Access tokens on demand. A rotated refresh token is stored before the new
 * access token is used; concurrent callers share one refresh.
 */
export function tokenSource(provider: OAuthProvider, readRefreshToken: () => string, saveRefreshToken: (token: string) => void, initial?: OAuthTokens) {
  let current = initial;
  let refreshing: Promise<string> | null = null;
  return async (): Promise<string> => {
    if (current && current.expiresAt > Date.now() + 60_000) return current.accessToken;
    if (!refreshing) refreshing = (async () => {
      const token = await tokenRequest(provider, new URLSearchParams({
        client_id: provider.clientId, grant_type: "refresh_token", refresh_token: readRefreshToken(), scope: provider.scope,
      }));
      if (token.refreshToken) saveRefreshToken(token.refreshToken);
      current = token;
      return token.accessToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
}

/** The claims of an ID token that came straight from the provider's token endpoint over TLS. */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
