/**
 * Mail, run inside the Vault process: the one place a mail password or an
 * Outlook refresh token is ever in the clear. The main process names an
 * account and a method; the connection is made here, with the secret read
 * here, and only the result goes back.
 */
import { GraphMailAccount, gmailConfig, ImapSmtpAccount, mailTargets, validateMailConfig, type MailAccount } from "@ocak/mail";
import { t } from "@ocak/i18n";
import type { VaultServer } from "@ocak/vault";
import { GOOGLE_TOKEN_TARGET, googleTokenSource } from "../main/google-oauth.js";
import { OAUTH_CLIENTS, type OAuthClients } from "../main/oauth-clients.js";
import { OUTLOOK_TOKEN_TARGET, outlookTokenSource } from "../main/outlook-oauth.js";
import type { StoredMailAccount } from "../main/settings.js";

/** What main may ask a mailbox to do. Nothing else is callable. */
export const MAIL_METHODS = ["ready", "search", "read", "saveDraft", "deleteDraft", "send", "awaitingReply", "move", "moveBack", "setRead"] as const;
export type MailMethod = (typeof MAIL_METHODS)[number];

/** Names under which the Vault keeps mail secrets. */
export const mailSecretName = (id: string): string => `mail.${id}`;

const MAIL_TARGET = /^(imap|smtp):/i;
const MCP_TARGET = /^mcp:/i;

/**
 * Whether a value may leave the Vault process. Mail and MCP secrets never
 * do, by name or by where they're bound: they are used here (./mail.ts,
 * ./mcp.ts). What's left — the outbox queue, the user's own entries — is
 * handed to its consumer in main.
 */
export function mayRelease(name: string, target: string | undefined): boolean {
  if (name.startsWith("mail.") || name.startsWith("mcp.")) return false;
  if (target !== undefined && (MAIL_TARGET.test(target) || MCP_TARGET.test(target) || target === OUTLOOK_TOKEN_TARGET || target === GOOGLE_TOKEN_TARGET)) return false;
  return true;
}

function spec(value: unknown): StoredMailAccount {
  if (!value || typeof value !== "object") throw new TypeError("mail account must be an object");
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new TypeError("mail account id is invalid");
  const addedAt = typeof raw.addedAt === "number" ? raw.addedAt : 0;
  if (raw.provider === "outlook" || raw.provider === "google") {
    if (typeof raw.email !== "string" || typeof raw.clientId !== "string") throw new TypeError(`${raw.provider} account is incomplete`);
    return { id, provider: raw.provider, email: raw.email, clientId: raw.clientId, addedAt };
  }
  const provider = raw.provider === "gmail" ? "gmail" : raw.provider === "imap" ? "imap" : undefined;
  return { id, config: validateMailConfig(raw.config), ...(provider && { provider }), addedAt };
}

export interface ServeMailOptions {
  /** An extra trusted certificate authority; only for tests against a local server. */
  testCa?: string;
  /** Vunemi's app registrations; the build's own unless a test gives others. */
  clients?: OAuthClients;
  /** Where Gmail's servers are; a local stand-in in tests. */
  gmailServers?: (email: string) => ReturnType<typeof gmailConfig>;
}

export function serveMail(server: VaultServer, opts: ServeMailOptions = {}): void {
  const vault = server.vault;
  // Keyed by the account as it was described: a changed description is a new account.
  const open = new Map<string, { key: string; account: MailAccount }>();

  const accountFor = (entry: StoredMailAccount): MailAccount => {
    const key = JSON.stringify(entry);
    const cached = open.get(entry.id);
    if (cached?.key === key) return cached.account;
    const name = mailSecretName(entry.id);
    if (!vault.has(name)) throw new Error(t("connectors.mail.passwordUnreadable"));
    // Saved before binding existed: bound to this account's servers now.
    vault.adopt(name, entry.provider === "outlook" ? [OUTLOOK_TOKEN_TARGET] : entry.provider === "google" ? [GOOGLE_TOKEN_TARGET] : mailTargets(entry.config));
    let account: MailAccount;
    if (entry.provider === "google") {
      const client = (opts.clients ?? OAUTH_CLIENTS).google;
      // Signed in through a registration this build doesn't have: sign in again.
      if (!client || client.clientId !== entry.clientId) throw new Error(t("main.google.reconnect"));
      const token = googleTokenSource(
        client,
        () => vault.use(name, GOOGLE_TOKEN_TARGET),
        (refresh) => vault.set(name, refresh, t("connectors.mail.googleSecretNote", { email: entry.email }), [GOOGLE_TOKEN_TARGET]),
      );
      account = new ImapSmtpAccount((opts.gmailServers ?? gmailConfig)(entry.email), async () => ({ accessToken: await token() }), opts.testCa);
    } else if (entry.provider === "outlook") {
      const token = outlookTokenSource(
        entry.clientId,
        () => vault.use(name, OUTLOOK_TOKEN_TARGET),
        (refresh) => vault.set(name, refresh, t("connectors.mail.outlookNote", { email: entry.email }), [OUTLOOK_TOKEN_TARGET]),
      );
      account = new GraphMailAccount(entry.email, token);
    } else {
      account = new ImapSmtpAccount(entry.config, (target) => vault.use(name, target), opts.testCa);
    }
    open.set(entry.id, { key, account });
    return account;
  };

  server.register("mail.call", async (rawSpec: unknown, method: unknown, args: unknown) => {
    const entry = spec(rawSpec);
    if (!MAIL_METHODS.includes(method as MailMethod)) throw new TypeError(`"${String(method)}" is not a mail method`);
    if (!Array.isArray(args) || args.length > 4) throw new TypeError("mail arguments must be a short list");
    if (method === "ready" && !vault.has(mailSecretName(entry.id))) return false;
    const account = accountFor(entry);
    const fn = (account as unknown as Record<string, unknown>)[method as string];
    if (typeof fn !== "function") throw new Error(`This mailbox can't ${String(method)}.`);
    return (fn as (...a: unknown[]) => unknown).apply(account, args);
  });

  server.register("mail.close", (id: unknown) => {
    if (typeof id === "string") open.delete(id);
  });

  /** A new account's first try, with the password it was typed with. */
  server.register("mail.verify", async (config: unknown, password: unknown) => {
    if (typeof password !== "string" || password.length === 0) throw new Error(t("connectors.mail.needPassword"));
    await new ImapSmtpAccount(validateMailConfig(config), () => password, opts.testCa).verify();
  });
}
