/**
 * Gmail signed in with Google. Mail itself still goes over IMAP and SMTP,
 * with the access token in place of a password (XOAUTH2); the refresh token
 * lives in the Vault and is used only by the Vault process.
 */
import { t } from "@vunemi/i18n";
import { authorize, idTokenClaims, tokenSource, type OAuthProvider, type OAuthTokens } from "./oauth.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
/** Where a Google refresh token may be sent: Google's token endpoint, nowhere else. */
export const GOOGLE_TOKEN_TARGET = "https:oauth2.googleapis.com";
/** Full mail access over IMAP/SMTP, and the address it belongs to. */
const SCOPE = "https://mail.google.com/ openid email";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

function provider(client: GoogleClient): OAuthProvider {
  if (!/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(client.clientId) || !client.clientSecret) {
    throw new Error(t("main.google.notConfigured"));
  }
  return {
    authUrl: AUTH, tokenUrl: TOKEN, clientId: client.clientId, clientSecret: client.clientSecret, scope: SCOPE,
    redirectHost: "127.0.0.1",
    // A refresh token every time, even for an account signed in before.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    messages: { tokenFailed: "main.google.tokenFailed", noTokens: "main.google.noTokens", notCompleted: "main.google.notCompleted", timeout: "main.google.timeout" },
  };
}

export function authorizeGoogle(client: GoogleClient, openBrowser: (url: string) => Promise<void>, timeoutMs = 300_000): Promise<OAuthTokens> {
  return authorize(provider(client), openBrowser, timeoutMs);
}

export function googleTokenSource(client: GoogleClient, readRefreshToken: () => string, saveRefreshToken: (token: string) => void) {
  return tokenSource(provider(client), readRefreshToken, saveRefreshToken);
}

/** The Gmail address the sign-in was for, as Google vouches for it. */
export function googleAddress(tokens: OAuthTokens): string {
  const claims = tokens.idToken ? idTokenClaims(tokens.idToken) : {};
  const email = claims.email;
  if (typeof email !== "string" || claims.email_verified === false || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(t("main.google.noAddress"));
  }
  return email;
}
