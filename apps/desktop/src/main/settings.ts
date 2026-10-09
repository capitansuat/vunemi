/**
 * The handful of choices that have to outlive the process: which
 * connections the user switched on, what they may do, which language.
 *
 * Deliberately not a settings framework. A single small JSON file, written
 * whole, read once — a preference store that can corrupt or half-write is a
 * strange way to lose someone's security choices.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY, type Autonomy, type AutonomyPolicy } from "@vunemi/agent-core";
import type { McpServerConfig } from "@vunemi/mcp";
import { validateMailConfig, type ImapSmtpConfig } from "@vunemi/mail";
import { isLocale, type Locale } from "@vunemi/i18n";
import { trustableHost } from "@vunemi/browser";
import type { Appearance, LocalModelSettings } from "../shared/ipc.js";
import { DEFAULT_MODEL_SETTINGS, validateModelSettings } from "./providers.js";
import { t } from "@vunemi/i18n";

export interface StoredImapMailAccount {
  id: string;
  config: ImapSmtpConfig;
  provider?: "gmail" | "imap";
  addedAt: number;
}

export interface StoredOutlookMailAccount {
  id: string;
  provider: "outlook";
  email: string;
  clientId: string;
  addedAt: number;
}

/** Gmail signed in with Google: IMAP/SMTP with an access token. */
export interface StoredGoogleMailAccount {
  id: string;
  provider: "google";
  email: string;
  clientId: string;
  addedAt: number;
}

/** An account the Mac's Mail app already has; Mail signs in, so nothing secret is kept. */
export interface StoredAppleMailAccount {
  id: string;
  provider: "applemail";
  /** Mail's name for the account. */
  account: string;
  email: string;
  addedAt: number;
}

export type StoredMailAccount = StoredImapMailAccount | StoredOutlookMailAccount | StoredGoogleMailAccount | StoredAppleMailAccount;

/** The address an account sends from, whichever way it signs in. */
export function mailAddressOf(entry: StoredMailAccount): string {
  return entry.provider === "outlook" || entry.provider === "google" || entry.provider === "applemail" ? entry.email : entry.config.email;
}

function copyMailAccount(entry: StoredMailAccount): StoredMailAccount {
  return entry.provider === "outlook" || entry.provider === "google" || entry.provider === "applemail" ? { ...entry } : { ...entry, config: { ...entry.config } };
}

export interface Settings {
  /** Connector id → on. Absent means "use that connector's own default". */
  connections: Record<string, boolean>;
  /**
   * MCP servers the user added. Their last known tool list is kept here too,
   * so the tools exist at startup without running every server at launch.
   */
  mcpServers: McpServerConfig[];
  policy: AutonomyPolicy;
  planBeforeRun: boolean;
  mailAccounts: StoredMailAccount[];
  modelSettings: LocalModelSettings;
  /** Null until chosen: then the system's language decides, if Vunemi speaks it. */
  language: Locale | null;
  /** Touch ID or the Mac password before the window answers. Off unless the user turns it on. */
  appLock: boolean;
  /**
   * Private-network hosts (a campus or company intranet) the browser may
   * open. Only the user adds them, here in Settings; never the agent.
   */
  trustedSites: string[];
  appearance: Appearance;
  /** Look for a new Vunemi once a day. On unless the user turns it off. */
  updatesCheck: boolean;
  /** Tell the others in a meeting apart by voice once it is over. Off unless the user turns it on. */
  meetingSpeakers: boolean;
  /**
   * The automation library (its page, the recipes, the summary before a
   * task is set up). Off, with no switch in the window yet: it is turned on
   * in the file, for trying it out.
   */
  automationLibrary: boolean;
}

const APPEARANCES = new Set<unknown>(["system", "light", "dark"]);
const isAppearance = (value: unknown): value is Appearance => APPEARANCES.has(value);

/** Enough for anyone's intranet; a list longer than this is no longer a choice. */
export const MAX_TRUSTED_SITES = 100;

/** Only hosts that can be trusted, once each, however they got into the file. */
function cleanSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = value.flatMap((raw) => {
    if (typeof raw !== "string") return [];
    const site = trustableHost(raw);
    return "host" in site ? [site.host] : [];
  });
  return [...new Set(hosts)].slice(0, MAX_TRUSTED_SITES);
}

const EMPTY: Settings = { connections: {}, mcpServers: [], policy: DEFAULT_POLICY, planBeforeRun: false, mailAccounts: [], modelSettings: DEFAULT_MODEL_SETTINGS, language: null, appLock: false, trustedSites: [], appearance: "system", updatesCheck: true, meetingSpeakers: false, automationLibrary: false };

/**
 * Settings that exist but can't be read. Everything falls back to its
 * default, except the lock: whether the user had one can no longer be told,
 * and a lock that opens because a file broke is no lock. It stays on until
 * the owner turns it off.
 */
function unreadable(err?: unknown): Settings {
  console.error("[vunemi] settings unreadable; starting from defaults, locked:", err ?? "not an object");
  return { ...EMPTY, appLock: true };
}
const CLASSES = ["read", "write-local", "destructive", "outbound", "financial"] as const;
const MODES = new Set<Autonomy>(["auto", "ask", "deny"]);

/**
 * The Sentinel refuses payments whatever the policy says; this keeps the
 * stored and displayed policy honest about it, so the settings screen never
 * shows a row as open that the gate will close.
 */
function closeMoney(policy: AutonomyPolicy): AutonomyPolicy {
  return { ...policy, financial: "deny" };
}

export function validPolicy(value: unknown): value is AutonomyPolicy {
  if (!value || typeof value !== "object") return false;
  return CLASSES.every((action) => MODES.has((value as AutonomyPolicy)[action]));
}

export class SettingsStore {
  private readonly file: string;
  private current: Settings;
  private trusted: ReadonlySet<string>;

  constructor(dir: string) {
    this.file = join(dir, "settings.json");
    this.current = this.read();
    this.trusted = new Set(this.current.trustedSites);
  }

  get all(): Settings {
    return { ...this.current, connections: { ...this.current.connections }, policy: { ...this.current.policy }, mailAccounts: this.mailAccounts, modelSettings: this.modelSettings };
  }

  get policy(): AutonomyPolicy {
    return { ...this.current.policy };
  }

  get planBeforeRun(): boolean {
    return this.current.planBeforeRun;
  }

  get meetingSpeakers(): boolean {
    return this.current.meetingSpeakers;
  }

  setMeetingSpeakers(on: boolean): void {
    this.replace({ ...this.current, meetingSpeakers: on });
  }

  setPolicy(policy: AutonomyPolicy, planBeforeRun = false): void {
    if (!validPolicy(policy)) throw new Error(t("main.invalidPolicy"));
    this.replace({ ...this.current, policy: closeMoney(policy), planBeforeRun });
  }

  get connections(): Record<string, boolean> {
    return { ...this.current.connections };
  }

  get mcpServers(): McpServerConfig[] {
    return this.current.mcpServers.map((server) => ({ ...server }));
  }

  get mailAccounts(): StoredMailAccount[] {
    return this.current.mailAccounts.map(copyMailAccount);
  }

  get modelSettings(): LocalModelSettings {
    return { endpoints: { ...this.current.modelSettings.endpoints }, ollamaContextLength: this.current.modelSettings.ollamaContextLength };
  }

  setModelSettings(input: LocalModelSettings): LocalModelSettings {
    const modelSettings = validateModelSettings(input);
    this.replace({ ...this.current, modelSettings });
    return this.modelSettings;
  }

  get language(): Locale | null {
    return this.current.language;
  }

  setLanguage(language: Locale): void {
    if (!isLocale(language)) throw new Error("Unknown language.");
    this.replace({ ...this.current, language });
  }

  setMailAccounts(accounts: StoredMailAccount[]): void {
    this.replace({ ...this.current, mailAccounts: accounts.map(copyMailAccount) });
  }

  setMcpServers(servers: McpServerConfig[]): void {
    this.replace({ ...this.current, mcpServers: servers.map((s) => ({ ...s })) });
  }

  setConnections(connections: Record<string, boolean>): void {
    this.replace({ ...this.current, connections: { ...connections } });
  }

  get appearance(): Appearance {
    return this.current.appearance;
  }

  setAppearance(appearance: Appearance): void {
    if (!isAppearance(appearance)) throw new Error("Unknown appearance.");
    this.replace({ ...this.current, appearance });
  }

  get automationLibrary(): boolean {
    return this.current.automationLibrary;
  }

  get updatesCheck(): boolean {
    return this.current.updatesCheck;
  }

  setUpdatesCheck(on: boolean): void {
    this.replace({ ...this.current, updatesCheck: on === true });
  }

  get appLock(): boolean {
    return this.current.appLock;
  }

  setAppLock(on: boolean): void {
    this.replace({ ...this.current, appLock: on === true });
  }

  /** The trusted private-network hosts, as a set the browser can ask. */
  get trustedSites(): ReadonlySet<string> {
    return this.trusted;
  }

  get trustedSiteList(): string[] {
    return [...this.current.trustedSites];
  }

  setTrustedSites(sites: string[]): void {
    this.replace({ ...this.current, trustedSites: cleanSites(sites) });
  }

  /**
   * Forgets everything but the language, the look, the lock and whether to
   * look for updates: a person who forgets their data has not forgotten how
   * to read, nor stopped wanting the door shut.
   */
  reset(): void {
    this.replace({ connections: {}, mcpServers: [], policy: { ...DEFAULT_POLICY }, planBeforeRun: false, mailAccounts: [], modelSettings: DEFAULT_MODEL_SETTINGS, language: this.current.language, appLock: this.current.appLock, trustedSites: [], appearance: this.current.appearance, updatesCheck: this.current.updatesCheck, meetingSpeakers: false, automationLibrary: this.current.automationLibrary });
  }

  private replace(next: Settings): void {
    const previous = this.current;
    this.current = next;
    try {
      this.write();
    } catch (err) {
      this.current = previous;
      throw err;
    }
    this.trusted = new Set(next.trustedSites);
  }

  private read(): Settings {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object") return unreadable();
      const connections = (parsed as Settings).connections;
      // Only booleans: a stray value here would silently decide a permission.
      const clean: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(connections ?? {})) {
        if (typeof on === "boolean") clean[id] = on;
      }
      const servers = Array.isArray((parsed as Settings).mcpServers) ? (parsed as Settings).mcpServers : [];
      const policy = (parsed as Settings).policy;
      const mail = Array.isArray((parsed as Settings).mailAccounts) ? (parsed as Settings).mailAccounts : [];
      const mailAccounts = mail.flatMap<StoredMailAccount>((entry: StoredMailAccount) => {
        try {
          if (!/^[a-z0-9-]{1,64}$/i.test(entry.id) || !Number.isFinite(entry.addedAt)) return [];
          if (entry.provider === "outlook") {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email) ||
                !/^[0-9a-f-]{36}$/i.test(entry.clientId)) return [];
            return [{ id: entry.id, provider: "outlook" as const, email: entry.email, clientId: entry.clientId, addedAt: entry.addedAt }];
          }
          if (entry.provider === "applemail") {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email) || typeof entry.account !== "string" ||
                !entry.account.trim() || entry.account.length > 200 || /[\u0000-\u001f]/u.test(entry.account)) return [];
            return [{ id: entry.id, provider: "applemail" as const, account: entry.account, email: entry.email, addedAt: entry.addedAt }];
          }
          if (entry.provider === "google") {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email) ||
                !/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(entry.clientId)) return [];
            return [{ id: entry.id, provider: "google" as const, email: entry.email, clientId: entry.clientId, addedAt: entry.addedAt }];
          }
          return [{ id: entry.id, config: validateMailConfig(entry.config), ...(entry.provider === "gmail" && { provider: "gmail" as const }), addedAt: entry.addedAt }];
        } catch {
          return [];
        }
      });
      let modelSettings: LocalModelSettings;
      try { modelSettings = validateModelSettings((parsed as Settings).modelSettings); }
      catch { modelSettings = DEFAULT_MODEL_SETTINGS; }
      // A file from before languages existed was written by someone using
      // Vunemi in Turkish, the only language it had; keep them there.
      const stored = (parsed as Settings).language;
      const language = stored === undefined ? "tr" : isLocale(stored) ? stored : null;
      return { connections: clean, mcpServers: servers.filter(isServer), policy: validPolicy(policy) ? closeMoney(policy) : { ...DEFAULT_POLICY }, planBeforeRun: (parsed as Settings).planBeforeRun === true, mailAccounts, modelSettings, language, appLock: (parsed as Settings).appLock === true, trustedSites: cleanSites((parsed as Settings).trustedSites), appearance: isAppearance((parsed as Settings).appearance) ? (parsed as Settings).appearance : "system", updatesCheck: (parsed as Settings).updatesCheck !== false, meetingSpeakers: (parsed as Settings).meetingSpeakers === true, automationLibrary: (parsed as Settings).automationLibrary === true };
    } catch (err) {
      // No file yet is a first launch. A file that can't be read is not.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      return unreadable(err);
    }
  }

  private write(): void {
    // Write beside and rename, so a crash mid-write cannot leave half a file.
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.current, null, 2), "utf8");
      renameSync(temp, this.file);
    } catch (err) {
      console.error("[vunemi] could not save settings:", err);
      throw err;
    }
  }
}

/** A hand-edited file should not be able to make us spawn nonsense. */
function isServer(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const server = value as McpServerConfig;
  if (typeof server.id !== "string" || typeof server.label !== "string") return false;
  const transport = server.transport;
  if (!transport || typeof transport !== "object") return false;
  if (transport.kind === "stdio") return typeof transport.command === "string" && transport.command !== "";
  if (transport.kind === "http") return typeof transport.url === "string" && /^https?:\/\//i.test(transport.url);
  return false;
}
