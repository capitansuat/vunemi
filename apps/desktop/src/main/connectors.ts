/**
 * Vunemi's catalogue of connections.
 *
 * Everything the agent can reach is one entry here, which is what lets the
 * user answer "what can this thing get at?" by looking at one screen. The
 * browser and the files are connections in exactly the same sense as a mail
 * account; the difference is only in what each one needs before it works.
 *
 * Defaults follow the threat model rather than convenience: what is local
 * and read-first starts on, and anything that acts on the user's own
 * machine or reaches an account of theirs starts off and is turned on
 * deliberately. The switch is remembered, so this costs a click once.
 */

import type { ToolDef, ToolRegistry } from "@vunemi/agent-core";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { APP_GUIDE_INDEX, createEverydayTools, createWhatsAppTool, createShortcutTools, SHORTCUTS_INSTRUCTIONS, createFinderTools, createGuideTool, createNotesTools, createOfficeTools, createRunner, createGeneralTools, onDemand, ScriptableCatalog, FINDER_INSTRUCTIONS, NOTES_INSTRUCTIONS } from "@vunemi/apps";
import { BROWSER_INSTRUCTIONS, type BrowserController, createBrowserTools, type TrustedSites } from "@vunemi/browser";
import { Connectors, type Capability, type Connector, type ConnectorStatus } from "@vunemi/connectors";
import { createFileTools, FILE_INSTRUCTIONS, type Roots } from "@vunemi/files";
import { CALENDAR_INSTRUCTIONS, createCalendarTools, createDesktopTools, DESKTOP_INSTRUCTIONS, type Helper } from "@vunemi/mac";
import { createMailTools, MAIL_INSTRUCTIONS, MailAccounts, Outbox, gmailAppPassword, gmailConfig, mailTargets, validateMailConfig } from "@vunemi/mail";
import { createMcpConnector, type McpServerConfig, type McpTool } from "@vunemi/mcp";
import { unsealed } from "./mcp-secrets.js";
import type { VaultClient } from "@vunemi/vault";
import { mailAddressOf, type StoredAppleMailAccount, type StoredMailAccount } from "./settings.js";
import { vaultMcpIO } from "./remote-mcp.js";
import { renderOfficePdf } from "./office-pdf.js";
import { travelConnectors, type TravelOptionsDeps } from "./travel.js";
import { AUTOMATION_INSTRUCTIONS, createAutomationTools, type AutomationStore } from "./automations.js";
import { authorizeOutlook, OUTLOOK_TOKEN_TARGET, outlookAddress } from "./outlook-oauth.js";
import { authorizeGoogle, GOOGLE_TOKEN_TARGET, googleAddress } from "./google-oauth.js";
import { OAUTH_CLIENTS, type OAuthClients } from "./oauth-clients.js";
import { RemoteMailAccount } from "./remote-mail.js";
import { AppleMailAccount, listMailAppAccounts } from "./apple-mail.js";
import { t, type MessageKey } from "@vunemi/i18n";

export interface CatalogueOptions {
  tools: ToolRegistry;
  browser: BrowserController;
  roots: Roots;
  appCatalog: ScriptableCatalog;
  shadowDir: string;
  helper: Helper;
  shotDir: string;
  remembered?: Record<string, boolean>;
  onChange?: (state: Record<string, boolean>) => void;
  /** Servers the user added before. */
  mcpServers?: McpServerConfig[];
  /** Called when a server tells us what it can do, so it can be saved. */
  onMcpTools?: (id: string, tools: McpTool[]) => void;
  mailAccounts?: StoredMailAccount[];
  saveMailAccounts?: (accounts: StoredMailAccount[]) => void;
  /** The Vault process's client. Mail runs there; MCP secrets are fetched from it when a server starts. */
  vault?: VaultClient;
  /** Settles once the Vault process first answered; the outbox is restored after it. */
  vaultReady?: Promise<void>;
  mailOutbox?: Outbox;
  openOAuthBrowser?: (url: string) => Promise<void>;
  /** Vunemi's Google and Microsoft registrations; the build's own by default. */
  oauthClients?: OAuthClients;
  /** Scheduled tasks; without it the connection is not offered. */
  automations?: AutomationStore;
  /** Replaced in tests: the osascript the Mail app accounts run through. */
  osascript?: string;
  /** Country from macOS regional settings, independent of conversation language. */
  countryCode?: () => string;
  /** Reads and shows pages in the embedded browser, for the flight search. */
  browserPages?: Pick<TravelOptionsDeps, "fetchPage" | "showPage">;
}

/**
 * Which provider a macOS calendar account belongs to.
 *
 * EventKit does not say "Google" — a Google account arrives as CalDAV like
 * any other, and only its title gives it away. Exchange is the one type
 * that names itself. Anything unrecognised is reported as local rather than
 * guessed at, because a wrong label here would tell the user their calendar
 * comes from somewhere it does not.
 */
function calendarProvider(source: string, kind: string): string {
  if (kind === "exchange") return "outlook";
  if (/google|gmail/i.test(source)) return "google";
  return "icloud";
}

/**
 * A switchable part whose name and one-liner are read when the list is shown,
 * not when it is built, so a change of language reaches a screen already open.
 */
function part(key: string, rest: Omit<Capability, "label" | "description">): Capability {
  return {
    ...rest,
    get label() { return t(`${key}.label` as MessageKey); },
    get description() { return t(`${key}.description` as MessageKey); },
  };
}

const APPS_INSTRUCTIONS = `Using Mac apps:
- Prefer these tools to clicking the screen: they are faster and do not depend on where windows are.
- If macOS refuses an app, tell the user to allow Vunemi under System Settings › Privacy & Security › Automation.

${NOTES_INSTRUCTIONS}

${FINDER_INSTRUCTIONS}

${APP_GUIDE_INDEX}`;

/**
 * Apps Vunemi drives through their own scripting dictionaries. macOS asks
 * the user once per app; a refusal is remembered here until a call to that
 * app works again, so the connection can say which app needs the switch.
 */
export function appsConnector(opts: { roots: Roots; catalog: ScriptableCatalog; osascript?: string; shotDir?: string; trusted?: () => TrustedSites }): Connector {
  const denied = new Set<string>();
  const run = createRunner({
    ...(opts.osascript && { osascript: opts.osascript }),
    onDenied: (app) => denied.add(app),
    onAllowed: (app) => denied.delete(app),
  });
  return {
    id: "apps",
    get label() { return t("connectors.apps.label"); },
    group: "computer",
    get description() { return t("connectors.apps.description"); },
    get provides() { return [t("connectors.apps.provides.notes"), t("connectors.apps.provides.finder")]; },
    capabilities: [
      part("connectors.apps.notes", { id: "notes", tools: ["notes_search", "notes_read", "notes_create", "notes_append"], defaultOn: true }),
      part("connectors.apps.notesChange", { id: "notes-change", tools: ["notes_edit", "notes_delete"], defaultOn: false }),
      part("connectors.apps.finder", { id: "finder", tools: ["finder_selection", "finder_reveal"], defaultOn: true }),
      part("connectors.apps.other", { id: "request", tools: ["app_guide", "apps_scriptable", "app_dictionary", "app_get", "app_command", "word_read", "word_export_pdf", "excel_read_range", "excel_write_range", "powerpoint_outline", "music_now_playing", "music_control", "music_play", "photos_search", "photos_export", "browser_tabs", "browser_open_url", "contacts_search", "messages_send", "whatsapp_compose"], defaultOn: true, hidden: true }),
    ],
    needs: { kind: "permission", get what() { return t("connectors.pane.automation"); } },
    // It acts in the user's own apps: an explicit yes.
    defaultOn: false,
    origin: "builtin",
    instructions: APPS_INSTRUCTIONS,
    status: async () =>
      denied.size === 0
        ? { state: "ready" }
        : { state: "blocked", settings: "automation", reason: t("connectors.apps.denied", { apps: [...denied].join(", ") }) },
    tools: () => {
      // Inside the screenshots folder: the window may show pictures from there, and nothing else.
      const everyday = createEverydayTools(run, opts.roots, { ...(opts.shotDir ? { thumbDir: join(opts.shotDir, "photos") } : {}), ...(opts.trusted && { trusted: opts.trusted }) });
      const pick = (...names: string[]) => everyday.filter((tool) => names.includes(tool.name));
      return [
        ...createNotesTools(run),
        ...createFinderTools(run, opts.roots),
        createGuideTool(),
        ...onDemand("office", createOfficeTools(run, opts.roots, opts.catalog, renderOfficePdf)),
        ...onDemand("music", pick("music_now_playing", "music_control", "music_play")),
        ...onDemand("photos", pick("photos_search", "photos_export")),
        ...onDemand("browsers", pick("browser_tabs", "browser_open_url")),
        ...onDemand("contacts", pick("contacts_search")),
        ...onDemand("messages", [...pick("messages_send"), createWhatsAppTool()]),
        ...onDemand("other_apps", createGeneralTools({ catalog: opts.catalog, run })),
      ];
    },
  };
}

/**
 * The user's shortcuts. Separate from Mac apps because a shortcut may do
 * anything its steps do, which Vunemi can't see: every run is a card.
 */
export function shortcutsConnector(opts: { osascript?: string } = {}): Connector {
  const denied = new Set<string>();
  const run = createRunner({
    ...(opts.osascript && { osascript: opts.osascript }),
    onDenied: (app) => denied.add(app),
    onAllowed: (app) => denied.delete(app),
  });
  return {
    id: "shortcuts",
    get label() { return t("connectors.shortcuts.label"); },
    group: "computer",
    get description() { return t("connectors.shortcuts.description"); },
    get provides() { return [t("connectors.shortcuts.provides.run")]; },
    capabilities: [part("connectors.shortcuts.run", { id: "run", tools: ["shortcuts_list", "shortcuts_run"], defaultOn: true })],
    needs: { kind: "permission", get what() { return t("connectors.pane.automation"); } },
    defaultOn: false,
    origin: "builtin",
    instructions: SHORTCUTS_INSTRUCTIONS,
    status: async () =>
      denied.size === 0
        ? { state: "ready" }
        : { state: "blocked", settings: "automation", reason: t("connectors.apps.denied", { apps: [...denied].join(", ") }) },
    tools: () => createShortcutTools(run),
  };
}

/** Tasks the user asked to run later; setting one up is a card every time. */
function automationsConnector(store: AutomationStore): Connector {
  return {
    id: "automations",
    get label() { return t("connectors.automations.label"); },
    group: "service",
    get description() { return t("connectors.automations.description"); },
    get provides() { return [t("connectors.automations.provides.create")]; },
    capabilities: [part("connectors.automations.create", { id: "create", tools: ["automation_create", "automation_list", "automation_set", "automation_delete"], defaultOn: true })],
    needs: { kind: "none" },
    defaultOn: false,
    origin: "builtin",
    instructions: AUTOMATION_INSTRUCTIONS,
    status: async () => ({ state: "ready" }),
    tools: () => createAutomationTools(store),
  };
}

export function buildConnectors(opts: CatalogueOptions): Connectors {
  const connectors = new Connectors({
    tools: opts.tools,
    ...(opts.remembered && { remembered: opts.remembered }),
    ...(opts.onChange && { onChange: opts.onChange }),
  });

  const calendarTools = createCalendarTools({ helper: opts.helper });
  const named = (prefix: string): ToolDef[] => calendarTools.filter((t) => t.name.startsWith(prefix));

  /** Reports a macOS permission as a state rather than an exception. */
  const macPermission = async (field: "accessibility" | "calendars" | "reminders"): Promise<ConnectorStatus> => {
    if (!opts.helper.installed) {
      return { state: "blocked", reason: t("connectors.helperMissing") };
    }
    const permissions = await opts.helper.permissions();
    if (permissions[field]) return { state: "ready" };
    if (field === "accessibility") {
      return {
        state: "blocked",
        settings: field,
        reason: permissions.trusted
          ? t("connectors.accessibilityProbe", { probe: permissions.probe ?? t("connectors.accessError") })
          : t("connectors.accessibilityMissing"),
      };
    }
    return { state: "blocked", settings: field, reason: t("connectors.noPermission", { pane: t(`connectors.pane.${field}`), button: t("connections.requestPermission") }) };
  };

  const all: Connector[] = [
    {
      id: "browser",
      get label() { return t("connectors.browser.label"); },
      group: "computer",
      get description() { return t("connectors.browser.description"); },
      get provides() { return [t("connectors.browser.provides.search"), t("connectors.browser.provides.read"), t("connectors.browser.provides.forms")]; },
      capabilities: [
        part("connectors.browser.read", {
          id: "read",
          tools: ["page_goto", "page_search", "page_back", "page_describe", "page_read", "page_screenshot", "page_find", "page_scroll", "page_wait", "tabs_list", "tabs_focus", "tabs_close", "user_takeover"],
          defaultOn: true,
        }),
        part("connectors.browser.act", {
          id: "act",
          tools: ["page_click", "page_type", "page_select", "page_press"],
          defaultOn: true,
        }),
      ],
      needs: { kind: "none" },
      // Isolated, watched, and the thing most tasks start with.
      defaultOn: false,
      origin: "builtin",
      instructions: BROWSER_INSTRUCTIONS,
      status: async () => ({ state: "ready" }),
      tools: () => createBrowserTools(opts.browser, { shotDir: opts.shotDir }),
    },

    {
      id: "files",
      get label() { return t("connectors.files.label"); },
      group: "computer",
      get description() { return t("connectors.files.description"); },
      get provides() { return [t("connectors.files.provides.read"), t("connectors.files.provides.write"), t("connectors.files.provides.convert")]; },
      capabilities: [
        part("connectors.files.read", { id: "read", tools: ["files_list", "files_search", "files_read"], defaultOn: true }),
        part("connectors.files.write", { id: "write", tools: ["files_write", "files_edit", "files_move", "files_trash"], defaultOn: false }),
        part("connectors.files.convert", { id: "convert", tools: ["system_run"], defaultOn: false }),
      ],
      needs: { kind: "permission", get what() { return t("connectors.files.needs"); } },
      // It writes to the user's own folders: an explicit yes, per the plan.
      defaultOn: false,
      origin: "builtin",
      instructions: FILE_INSTRUCTIONS,
      status: async () => ({ state: "ready" }),
      tools: () => createFileTools({ roots: opts.roots, shadowDir: opts.shadowDir }),
    },

    {
      id: "desktop",
      get label() { return t("connectors.desktop.label"); },
      group: "computer",
      get description() { return t("connectors.desktop.description"); },
      get provides() { return [t("connectors.desktop.provides.read"), t("connectors.desktop.provides.click"), t("connectors.desktop.provides.type")]; },
      capabilities: [
        part("connectors.desktop.read", {
          id: "read",
          tools: ["desktop_apps", "desktop_describe", "desktop_screenshot", "desktop_focus"],
          defaultOn: true,
        }),
        part("connectors.desktop.act", { id: "act", tools: ["desktop_click", "desktop_type", "desktop_key"], defaultOn: false }),
      ],
      needs: { kind: "permission", what: "Accessibility" },
      // The widest privilege in the product. Off until asked for.
      defaultOn: false,
      origin: "builtin",
      instructions: DESKTOP_INSTRUCTIONS,
      status: () => macPermission("accessibility"),
      tools: () => createDesktopTools({ helper: opts.helper, shotDir: opts.shotDir }),
      connect: async () => {
        await opts.helper.permissions(true); // shows the system prompt once
        return macPermission("accessibility");
      },
    },

    appsConnector({ roots: opts.roots, catalog: opts.appCatalog, shotDir: opts.shotDir, trusted: opts.browser.trusted }),

    shortcutsConnector(),

    ...(opts.automations ? [automationsConnector(opts.automations)] : []),

    {
      id: "calendar",
      get label() { return t("connectors.calendar.label"); },
      group: "service",
      get description() { return t("connectors.calendar.description"); },
      get provides() { return [t("connectors.calendar.provides.read"), t("connectors.calendar.provides.add")]; },
      // Google Calendar is a real question with a boring answer: macOS
      // already syncs it, and reading it through EventKit means no token
      // ever reaches Vunemi. Listed here so the answer is in the product
      // rather than only in someone's head.
      providers: [
        { id: "icloud", get label() { return t("connectors.calendar.icloud"); }, available: true },
        { id: "google", get label() { return t("connectors.calendar.google"); }, available: true, get note() { return t("connectors.calendar.googleNote"); } },
        { id: "outlook", label: "Outlook", available: true, get note() { return t("connectors.calendar.outlookNote"); } },
      ],
      accounts: async () => {
        // Whatever macOS is already syncing. Each calendar's source is the
        // account, so this lists what is really reachable rather than what
        // we hoped was.
        if (!opts.helper.installed) return [];
        try {
          const found = (await opts.helper.call("calendars", {})) as { source?: string; sourceKind?: string }[];
          const seen = new Map<string, string>();
          for (const cal of found) {
            if (cal.source && !seen.has(cal.source)) seen.set(cal.source, cal.sourceKind ?? "other");
          }
          return [...seen].map(([source, kind]) => ({
            id: source,
            label: source,
            provider: calendarProvider(source, kind),
            addedAt: 0,
            state: "ready" as const,
          }));
        } catch {
          return [];
        }
      },
      addAccount: async () => {
        throw new Error(t("connectors.calendar.addInMacos"));
      },
      capabilities: [
        part("connectors.calendar.read", { id: "read", tools: ["calendar_events"], defaultOn: true }),
        part("connectors.calendar.write", { id: "write", tools: ["calendar_create", "calendar_update", "calendar_delete"], defaultOn: false }),
      ],
      needs: { kind: "permission", what: "Calendars" },
      defaultOn: false,
      origin: "builtin",
      instructions: CALENDAR_INSTRUCTIONS,
      status: () => macPermission("calendars"),
      tools: () => named("calendar_"),
      connect: async () => {
        await opts.helper.call("request_calendar", { kind: "event" });
        return macPermission("calendars");
      },
    },

    {
      id: "reminders",
      get label() { return t("connectors.reminders.label"); },
      group: "service",
      get description() { return t("connectors.reminders.description"); },
      get provides() { return [t("connectors.reminders.provides.read"), t("connectors.reminders.provides.add")]; },
      capabilities: [
        part("connectors.reminders.read", { id: "read", tools: ["reminders_list"], defaultOn: true }),
        part("connectors.reminders.write", { id: "write", tools: ["reminder_create", "reminder_done", "reminder_update", "reminder_delete"], defaultOn: false }),
      ],
      needs: { kind: "permission", what: "Reminders" },
      defaultOn: false,
      origin: "builtin",
      status: () => macPermission("reminders"),
      tools: () => named("reminder"),
      connect: async () => {
        await opts.helper.call("request_calendar", { kind: "reminder" });
        return macPermission("reminders");
      },
    },

    mailConnector(opts),
    ...travelConnectors({ countryCode: opts.countryCode, ...opts.browserPages }),
  ];

  for (const connector of all) connectors.add(connector);

  // Whatever the user plugged in themselves. Added last so a server cannot
  // take a built-in connection's id and quietly replace it.
  for (const server of opts.mcpServers ?? []) {
    if (all.some((c) => c.id === server.id)) continue;
    // A server with secrets runs from the Vault process, which fills them
    // in there; main never holds them.
    if (server.secretRefs && !opts.vault) {
      connectors.add(sealedAway(server, "connectors.mcpSecrets.reason"));
      continue;
    }
    // Secrets still in the settings file wait for the move into the Vault
    // (index.ts replaces this then); main doesn't run a server with them.
    if (unsealed(server)) {
      connectors.add(sealedAway(server, "connectors.mcpSecrets.moving"));
      continue;
    }
    connectors.add(createMcpConnector({
      config: server,
      ...(server.secretRefs && { io: vaultMcpIO(opts.vault!, server) }),
      ...(opts.onMcpTools && { onTools: opts.onMcpTools }),
    }));
  }
  return connectors;
}

/** An MCP server shown but not run: its secrets can't be used from here (yet). */
export function sealedAway(server: McpServerConfig, reason: "connectors.mcpSecrets.reason" | "connectors.mcpSecrets.moving"): Connector {
  return {
    id: server.id, label: server.label, group: "service", origin: "mcp", defaultOn: false,
    get description() { return t("connectors.mcpSecrets.description"); }, provides: [], needs: { kind: "account", provider: "mcp" },
    status: async () => ({ state: "blocked", reason: t(reason) }),
    tools: () => [],
  };
}

/**
 * The ways to add a mailbox. Signing in with Google or Microsoft is offered
 * when this build carries Vunemi's registration with them; otherwise the
 * older ways remain (an app password, your own Microsoft application).
 */
export function mailProviderOptions(clients: OAuthClients) {
  return [
    // First: most people already have their mail in Mail, and it needs nothing typed.
    { id: "applemail", get label() { return t("connectors.mail.appleMailLabel"); }, available: true, get note() { return t("connectors.mail.appleMailNote"); } },
    ...(clients.google ? [{ id: "google", get label() { return t("connectors.mail.googleLabel"); }, available: true, get note() { return t("connectors.mail.googleProviderNote"); } }] : []),
    ...(clients.microsoft ? [{ id: "microsoft", get label() { return t("connectors.mail.microsoftLabel"); }, available: true, get note() { return t("connectors.mail.microsoftProviderNote"); } }] : []),
    { id: "gmail", label: "Gmail", available: true, get note() { return t("connectors.mail.gmailNote"); } },
    ...(clients.microsoft ? [] : [{ id: "outlook", label: "Outlook", available: true, get note() { return t("connectors.mail.outlookProviderNote"); } }]),
    { id: "imap", label: "IMAP + SMTP", available: true, get note() { return t("connectors.mail.imapNote"); } },
  ];
}

/**
 * Mail: a connection that holds accounts rather than one account wearing a
 * connection's clothes. A person has a personal mailbox and a work one, and
 * both have to be here at the same time — so the connection is "mail" and
 * each mailbox is an account inside it. The tools stay singular and take the
 * mailbox as an argument; ten tools per account would bury a small model.
 *
 * IMAP reads and stores drafts; SMTP sends after the outbox hold expires.
 * Mail app accounts hold no secret: they run here, through Apple Events.
 */
export function mailConnector(opts: CatalogueOptions): Connector {
  const accounts = new MailAccounts();
  const outbox = opts.mailOutbox ?? new Outbox();
  let saved = [...(opts.mailAccounts ?? [])];
  const secretName = (id: string) => `mail.${id}`;
  const addressOf = mailAddressOf;
  const vault = opts.vault;
  const clients = opts.oauthClients ?? OAUTH_CLIENTS;
  /** Whether macOS last refused Vunemi control of Mail; cleared when a call works again. */
  let mailDenied = false;
  const run = createRunner({
    ...(opts.osascript && { osascript: opts.osascript }),
    onDenied: () => { mailDenied = true; },
    onAllowed: () => { mailDenied = false; },
  });
  const isMailApp = (entry: StoredMailAccount): entry is StoredAppleMailAccount => entry.provider === "applemail";
  /** One sign-in's refresh token into the Vault, then the account into settings; neither without the other. */
  const addSignedIn = async (entry: StoredMailAccount, refreshToken: string, note: string, target: string) => {
    if (saved.some((item) => addressOf(item).toLowerCase() === addressOf(entry).toLowerCase())) {
      throw new Error(t("connectors.mail.duplicate"));
    }
    // Written once from here; from now on only the Vault process reads it.
    await vault!.set(secretName(entry.id), refreshToken, note, [target]);
    try { opts.saveMailAccounts!([...saved, entry]); }
    catch (err) { await vault!.delete(secretName(entry.id)); throw err; }
    saved = [...saved, entry];
    sync();
    return { id: entry.id, label: addressOf(entry), provider: entry.provider ?? "imap", addedAt: entry.addedAt, state: "ready" as const };
  };
  // The accounts whose secret the Vault can read, kept current as it opens,
  // restarts or changes. The connection itself is made in the Vault process.
  const sync = (): void => {
    for (const entry of saved) {
      if (isMailApp(entry)) {
        if (!accounts.all().some((item) => item.id === entry.id)) accounts.add({ id: entry.id, label: entry.email, account: new AppleMailAccount(run, entry) });
        continue;
      }
      if (!vault) continue;
      const readable = vault.has(secretName(entry.id));
      const present = accounts.all().some((item) => item.id === entry.id);
      if (readable && !present) accounts.add({ id: entry.id, label: addressOf(entry), account: new RemoteMailAccount(vault, entry) });
      else if (!readable && present) accounts.remove(entry.id);
    }
  };
  vault?.onChange(sync);
  sync();
  let outboxError: string | null = null;
  void (opts.vaultReady ?? Promise.resolve()).then(async () => {
    sync();
    try {
      await outbox.restore((id) => accounts.all().find((entry) => entry.id === id)?.account);
    } catch (err) {
      outboxError = err instanceof Error ? err.message : String(err);
      console.error("[vunemi] mail outbox restore failed:", outboxError);
    }
  });

  return {
    id: "mail",
    get label() { return t("connectors.mail.label"); },
    group: "service",
    get description() { return t("connectors.mail.description"); },
    get provides() { return [t("connectors.mail.provides.read"), t("connectors.mail.provides.draft"), t("connectors.mail.provides.send")]; },
    capabilities: [
      part("connectors.mail.read", { id: "read", tools: ["mail_search", "mail_awaiting_reply", "mail_read"], defaultOn: true }),
      part("connectors.mail.draft", { id: "draft", tools: ["mail_draft"], defaultOn: false }),
      part("connectors.mail.send", { id: "send", tools: ["mail_send"], defaultOn: false }),
      part("connectors.mail.organize", { id: "organize", tools: ["mail_trash", "mail_archive", "mail_move", "mail_mark"], defaultOn: false }),
    ],
    needs: { kind: "account", provider: "email" },
    defaultOn: false,
    origin: "builtin",
    instructions: MAIL_INSTRUCTIONS,
    providers: mailProviderOptions(clients),
    accounts: async () =>
      saved.map((entry) => {
        const ok = isMailApp(entry) ? !mailDenied : vault?.has(secretName(entry.id)) === true;
        const reason = isMailApp(entry) ? t("connectors.apps.denied", { apps: "Mail" }) : t("connectors.mail.passwordUnreadable");
        return {
          id: entry.id,
          label: addressOf(entry),
          provider: entry.provider ?? "imap",
          addedAt: entry.addedAt,
          state: ok ? "ready" as const : "blocked" as const,
          ...(!ok && { reason }),
        };
      }),
    addAccount: async (provider, input) => {
      const known = ["applemail", "imap", "gmail", "outlook", ...(clients.google ? ["google"] : []), ...(clients.microsoft ? ["microsoft"] : [])];
      if (!known.includes(provider)) throw new Error(t("connectors.mail.noFlow", { provider }));
      if (provider === "applemail") {
        if (!opts.saveMailAccounts) throw new Error(t("connectors.mail.noVault"));
        const name = String((input as { account?: unknown } | undefined)?.account ?? "").trim();
        const found = (await listMailAppAccounts(run)).find((item) => item.name === name);
        const email = found?.emails.find((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
        if (!found || !email) throw new Error(t("connectors.mail.appleMailUnknown", { name }));
        // The same mailbox twice would answer every search twice.
        if (saved.some((item) => addressOf(item).toLowerCase() === email.toLowerCase() || (isMailApp(item) && item.account === name))) {
          throw new Error(t("connectors.mail.duplicate"));
        }
        const entry: StoredAppleMailAccount = { id: randomUUID(), provider: "applemail", account: name, email, addedAt: Date.now() };
        opts.saveMailAccounts([...saved, entry]);
        saved = [...saved, entry];
        sync();
        return { id: entry.id, label: email, provider: "applemail", addedAt: entry.addedAt, state: "ready" as const };
      }
      if (!vault?.available || !opts.saveMailAccounts) throw new Error(t("connectors.mail.noVault"));
      // Signing in with Google or Microsoft takes no details; the rest do.
      if (provider !== "google" && provider !== "microsoft" && (!input || typeof input !== "object")) throw new Error(t("connectors.mail.needDetails"));
      const raw = (input ?? {}) as Record<string, unknown>;
      if (provider === "google") {
        if (!opts.openOAuthBrowser) throw new Error(t("connectors.mail.noOAuthBrowser"));
        const client = clients.google!;
        const tokens = await authorizeGoogle(client, opts.openOAuthBrowser);
        const email = googleAddress(tokens);
        const entry: StoredMailAccount = { id: randomUUID(), provider: "google", email, clientId: client.clientId, addedAt: Date.now() };
        return addSignedIn(entry, tokens.refreshToken, t("connectors.mail.googleSecretNote", { email }), GOOGLE_TOKEN_TARGET);
      }
      if (provider === "outlook" || provider === "microsoft") {
        if (!opts.openOAuthBrowser) throw new Error(t("connectors.mail.noOAuthBrowser"));
        const clientId = provider === "microsoft" ? clients.microsoft!.clientId : String(raw.clientId ?? "").trim();
        const tokens = await authorizeOutlook(clientId, opts.openOAuthBrowser);
        const email = await outlookAddress(tokens.accessToken);
        const entry: StoredMailAccount = { id: randomUUID(), provider: "outlook", email, clientId, addedAt: Date.now() };
        return addSignedIn(entry, tokens.refreshToken, t("connectors.mail.outlookNote", { email }), OUTLOOK_TOKEN_TARGET);
      }
      const config = provider === "gmail" ? gmailConfig(raw.email) : validateMailConfig(input);
      const password = provider === "gmail" ? gmailAppPassword(raw.password) : raw.password;
      if (typeof password !== "string" || password.length < 1) throw new Error(t("connectors.mail.needPassword"));
      if (saved.some((entry) => addressOf(entry).toLowerCase() === config.email.toLowerCase())) {
        throw new Error(t("connectors.mail.duplicate"));
      }
      try {
        // Tried from the Vault process, like every later connection.
        await vault.call("mail.verify", [config, password], 120_000);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const cause = /auth|login|535|credentials|password/i.test(message)
          ? t("connectors.mail.cause.auth")
          : /starttls|tls|ssl|certificate|self.signed/i.test(message)
            ? t("connectors.mail.cause.tls")
          : /timed? ?out|timeout|etimedout/i.test(message)
            ? t("connectors.mail.cause.timeout")
            : /enotfound|dns|econnrefused|connect/i.test(message)
              ? t("connectors.mail.cause.unreachable")
              : t("connectors.mail.cause.failed");
        throw new Error(t(provider === "gmail" ? "connectors.mail.gmailFailed" : "connectors.mail.imapFailed", { cause }));
      }
      const entry: StoredMailAccount = { id: randomUUID(), config, ...(provider === "gmail" && { provider: "gmail" }), addedAt: Date.now() };
      await vault.set(secretName(entry.id), password, t("connectors.mail.imapNote2", { email: config.email }), mailTargets(config));
      try {
        opts.saveMailAccounts([...saved, entry]);
      } catch (err) {
        await vault.delete(secretName(entry.id));
        throw err;
      }
      saved = [...saved, entry];
      sync();
      return { id: entry.id, label: config.email, provider, addedAt: entry.addedAt, state: "ready" };
    },
    removeAccount: async (id) => {
      const entry = saved.find((item) => item.id === id);
      if (!entry) throw new Error(t("connectors.mail.accountNotFound"));
      if (outbox.hasWorkFor(addressOf(entry))) {
        throw new Error(t("connectors.mail.pendingWork"));
      }
      opts.saveMailAccounts?.(saved.filter((item) => item.id !== id));
      saved = saved.filter((item) => item.id !== id);
      accounts.remove(id);
      // A Mail app account left nothing in the Vault.
      if (isMailApp(entry)) return;
      await vault?.call("mail.close", [id]).catch(() => undefined);
      await vault?.delete(secretName(id));
    },
    status: async () =>
      outboxError
        ? { state: "blocked", reason: outboxError }
        : mailDenied && saved.some(isMailApp)
        ? { state: "blocked", settings: "automation", reason: t("connectors.apps.denied", { apps: "Mail" }) }
        : accounts.size === 0
        ? { state: "blocked", reason: !saved.length ? t("connectors.mail.noAccounts") : vault?.available ? t("connectors.mail.passwordsUnreadable") : t("vaultStore.locked") }
        : { state: "ready", account: accounts.list().map((a) => a.label).join(", ") },
    tools: () => createMailTools({ accounts, outbox }),
  };
}
