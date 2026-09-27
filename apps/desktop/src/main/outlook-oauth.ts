/** Microsoft public-client sign-in. Credentials stay in the system browser. */
import { t } from "@vunemi/i18n";
import { authorize, tokenSource, type OAuthProvider, type OAuthTokens } from "./oauth.js";

const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
/** Where an Outlook refresh token may be sent: Microsoft's token endpoint, nowhere else. */
export const OUTLOOK_TOKEN_TARGET = "https:login.microsoftonline.com";
const SCOPE = "offline_access User.Read Mail.ReadWrite Mail.Send";

export type OutlookTokens = OAuthTokens;

function validClientId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(t("main.outlook.badClientId"));
  }
  return value;
}

function provider(clientIdInput: string): OAuthProvider {
  return {
    authUrl: AUTH, tokenUrl: TOKEN, clientId: validClientId(clientIdInput), scope: SCOPE, redirectHost: "localhost",
    extraAuthParams: { response_mode: "query" },
    messages: { tokenFailed: "main.outlook.tokenFailed", noTokens: "main.outlook.noTokens", notCompleted: "main.outlook.notCompleted", timeout: "main.outlook.timeout" },
  };
}

/**
 * A short-lived localhost callback, with state and PKCE; never an embedded
 * login page. The permissions asked for are ones a user may grant for
 * themselves: no administrator's consent is needed (unless an organisation
 * has turned user consent off, which is its call).
 */
export async function authorizeOutlook(clientIdInput: string, openBrowser: (url: string) => Promise<void>, timeoutMs = 300_000): Promise<OutlookTokens> {
  return authorize(provider(clientIdInput), openBrowser, timeoutMs);
}

/** Rotating refresh tokens are persisted before the new access token is used. */
export function outlookTokenSource(clientIdInput: string, readRefreshToken: () => string, saveRefreshToken: (token: string) => void, initial?: OutlookTokens) {
  return tokenSource(provider(clientIdInput), readRefreshToken, saveRefreshToken, initial);
}

export async function outlookAddress(accessToken: string): Promise<string> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(t("main.outlook.profileFailed", { status: response.status }));
  const profile = await response.json() as { mail?: unknown; userPrincipalName?: unknown };
  const address = typeof profile.mail === "string" && profile.mail ? profile.mail : profile.userPrincipalName;
  if (typeof address !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(t("main.outlook.noAddress"));
  }
  return address;
}
