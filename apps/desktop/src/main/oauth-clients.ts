/**
 * Vunemi's own app registrations with Google and Microsoft, so a user signs
 * in with a click instead of creating an app password or an app of their
 * own. Filled in at build time (electron.vite.config.ts) from
 * apps/desktop/oauth-clients.local.json or VUNEMI_GOOGLE_CLIENT_ID,
 * VUNEMI_GOOGLE_CLIENT_SECRET and VUNEMI_MICROSOFT_CLIENT_ID.
 *
 * Missing means that sign-in isn't offered, and the older ways stay:
 * an app password for Gmail, your own application id for Outlook.
 *
 * A desktop app's client secret isn't a secret — anyone can read it out of
 * the app — and Google says as much; it's only required by the protocol.
 */
export interface OAuthClients {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string };
}

declare const __VUNEMI_OAUTH__: OAuthClients | undefined;

export const OAUTH_CLIENTS: OAuthClients = typeof __VUNEMI_OAUTH__ === "undefined" ? {} : __VUNEMI_OAUTH__;
