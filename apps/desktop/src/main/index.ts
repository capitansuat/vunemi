import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, powerMonitor, safeStorage, shell, systemPreferences, utilityProcess, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { type AgentEvent, type ApprovalDecision, type HandoffOutcome, type PlanDecision } from "@vunemi/agent-core";
import { BrowserController } from "@vunemi/browser";
import { projectFolderProblem, Roots } from "@vunemi/files";
import { Helper } from "@vunemi/mac";
import { HOLD_MS, Outbox, type OutboxEvent, type StoredSend } from "@vunemi/mail";
import { CH, EMERGENCY_STOP_ACCELERATOR, type ArtefactView, type AutomationView, type ContextInfo, type DownloadRequest, type LocalModelSettings, type LockAttempt, type LockState, type MailAccountInput, type NewMcpServer, type PaneBounds, type PermissionSettings, type SessionList, type StartRunRequest, type VaultStatus } from "../shared/ipc.js";
import { createMcpConnector, type McpServerConfig, type McpTool } from "@vunemi/mcp";
import { Sentinel } from "@vunemi/sentinel";
import { isLegacyCipher } from "@vunemi/vault";
import { VaultHost } from "./vault-host.js";
import { projectInstructions, ProjectStore } from "./projects.js";
import { ActivityLog } from "./activity.js";
import { AppLock, type AuthResult } from "./app-lock.js";
import { ArtefactStore, openable } from "./artefacts.js";
import { carryOverBrowserData, EmbeddedBackend, EmbeddedBrowser } from "./embedded-browser.js";
import { Presence } from "./presence.js";
import { isLocalTestBuild, remoteDebugging, scrubEnv, shouldOfferMove } from "./hardening.js";
import { engineBinary } from "./engine/binary.js";
import { EngineService } from "./engine/service.js";
import { Voice, whisperBinary } from "./voice.js";
import { DownloadError } from "./engine/download.js";
import { buildConnectors } from "./connectors.js";
import { ScriptableCatalog, shortcutName } from "@vunemi/apps";
import { createDemoTools } from "./demo-tools.js";
import { SettingsStore, validPolicy } from "./settings.js";
import { migrateMcpSecrets, removeMcpSecrets, sealMcpServer, unsealed } from "./mcp-secrets.js";
import { vaultMcpIO } from "./remote-mcp.js";
import { checkAgentModel, modelConfig, probeProviders } from "./providers.js";
import { forgetOldPictures, loadImage, readImageText } from "./images.js";
import { AgentSession } from "./session.js";
import { SessionStore } from "./sessions.js";
import { PreferenceStore, rememberPreferenceTool } from "./preferences.js";
import { AutomationStore, describeSchedule, nextSlot, Scheduler, scheduledGoal, suggestion, summaryLine, type AutomationStatus } from "./automations.js";
import { getLocale, isLocale, localeInfo, matchLocale, setLocale, t, type Locale } from "@vunemi/i18n";

const here = fileURLToPath(new URL(".", import.meta.url));

// A development run is a different app from the one people install, and it
// must not share its data or its keychain key. Both used to be named after
// the package, so `pnpm dev` created the vault's keychain key, listing only
// its own ad-hoc Electron binary — and the installed Vunemi could not read
// the secrets it had saved. The name decides both the data folder and the
// "<name> Safe Storage" keychain entry, so it is set before either is used.
if (!app.isPackaged) {
  app.setName(`${app.getName()}-dev`);
  // VUNEMI_DEV_USER_DATA gives a development run a clean profile, to see what a
  // first launch looks like. Development only: a packaged app ignores it.
  app.setPath("userData", process.env.VUNEMI_DEV_USER_DATA || join(app.getPath("appData"), app.getName()));
}

// Before anything is started: nothing Vunemi launches inherits a loader or
// runtime override from whatever launched Vunemi. (Development runs keep
// theirs; the dev server may rely on them.)
if (app.isPackaged) {
  const removed = scrubEnv(process.env);
  if (removed.length > 0) console.warn(`[hardening] ignored launch environment: ${removed.join(", ")}`);
}

// The data folder is named after the app, not the package. Before anything
// reads or writes it.
if (app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Vunemi"));
carryOverBrowserData(app.getPath("userData"));

// Remote debugging lets any program on this Mac drive the window. A local
// test build allows it with a warning on screen; any other build won't start.
/** The app's own package.json; none reads as a build for other people. */
function ownManifest(): string {
  try {
    return readFileSync(join(app.getAppPath(), "package.json"), "utf8");
  } catch {
    return "";
  }
}

const debugPortOpen = app.isPackaged && remoteDebugging(process.argv);
if (debugPortOpen) {
  if (!isLocalTestBuild(ownManifest())) {
    dialog.showErrorBox("Vunemi", t("main.debugPort.refused"));
    app.exit(1);
  } else {
    console.warn("[hardening] remote debugging is open (local test build)");
  }
}


let win: BrowserWindow | null = null;
let quitting = false;

/** To the renderer, if it's still there: events can fire while the window is closing. */
function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

// The agent browses inside the Vunemi window, where the user can watch and
// step in. Nothing to install.
const embedded = new EmbeddedBrowser();
const browser = new BrowserController(async () => {
  if (!embedded.available) throw new Error("The Vunemi window is closed, so its browser is unavailable.");
  return new EmbeddedBackend(embedded);
});

browser.onPointer((target, p) => embedded.showPointer(target, p));

const tools = createDemoTools();

// The folders the user opened to Vunemi — Desktop, Documents, Downloads — and
// nothing else. Overwritten files are kept aside so the log can undo them.
const roots = new Roots();

// The Mac itself, through the signed Swift helper. Without it — or without
// the Accessibility permission — these tools simply say so and the rest of
// Vunemi carries on.
const helperPath =
  process.env.VUNEMI_HELPER ??
  (app.isPackaged
    ? join(process.resourcesPath, "VunemiHelper")
    : join(here, "../../../../native/VunemiHelper/.build/release/VunemiHelper"));
const helper = new Helper(helperPath);
const shotDir = join(app.getPath("userData"), "shots");
mkdirSync(shotDir, { recursive: true });
// Small copies of found photos are for looking back a while, not for keeping.
forgetOldPictures(join(shotDir, "photos"), 30 * 24 * 60 * 60_000);

// Everything the agent can reach, as one list the user controls. A switch
// that is off takes its tools out of the model's reach entirely.
const settings = new SettingsStore(app.getPath("userData"));

// The language before anything says a word. Someone who never chose one gets
// their Mac's, if Vunemi speaks it, and English if it does not.
setLocale(settings.language ?? matchLocale(app.getPreferredSystemLanguages()) ?? "en");

// The optional lock, off unless the user turned it on. macOS asks, in its
// own dialog, through a helper process of its own — so a Touch ID prompt
// waiting on the user holds up nothing else.
const appLock = new AppLock(() => settings.appLock, async (reason, signal): Promise<AuthResult> => {
  const authHelper = new Helper(helperPath);
  // Ending the helper takes its dialog down with it.
  const takeDown = () => authHelper.dispose();
  signal.addEventListener("abort", takeDown, { once: true });
  try {
    const answer = (await authHelper.call("authenticate", { reason }, { timeoutMs: 150_000 })) as { ok?: unknown; reason?: unknown; detail?: unknown };
    if (answer.ok === true) return { ok: true };
    const why = ["cancelled", "failed", "unavailable", "timeout"].includes(String(answer.reason)) ? (answer.reason as "cancelled" | "failed" | "unavailable" | "timeout") : "error";
    return { ok: false, reason: why, ...(typeof answer.detail === "string" && answer.detail && { detail: answer.detail }) };
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    throw err;
  } finally {
    signal.removeEventListener("abort", takeDown);
    authHelper.dispose();
  }
});

/**
 * What a locked window may still ask for: whether it is locked, to be
 * unlocked, which language to say so in — and to stop a run or stop talking.
 * The lock never stands between the user and silencing the agent.
 */
const OPEN_WHILE_LOCKED = new Set<string>([CH.lockGet, CH.lockUnlock, CH.languageGet, CH.stopRun, CH.pauseRun, CH.stopSpeaking]);

/** ipcMain.handle, behind the lock. Every channel goes through here. */
function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (appLock.isLocked && !OPEN_WHILE_LOCKED.has(channel)) throw new Error(t("lock.locked"));
    return listener(event, ...args);
  });
}

/** The Mac's own lock screen is up: nobody can answer a Touch ID prompt now. */
let macAway = false;

const lockState = (): LockState => ({ enabled: settings.appLock, locked: appLock.isLocked, away: macAway });

/** macOS's answer, for the window: a cancel is the user's choice and says nothing. */
function lockAttempt(result: AuthResult): LockAttempt {
  if (result.ok) return { ok: true, state: lockState() };
  const message = result.reason === "cancelled" ? null : t(`lock.error.${result.reason}`);
  return { ok: false, state: lockState(), message };
}

/**
 * Which language the model answers in. The user's own words come first — a
 * German setting must not answer a Turkish question in German (measured: put
 * the setting first and qwen3.6 does exactly that). The setting decides only
 * when the request has no language of its own, like "2+2=?".
 */
function languageInstructions(): string {
  const { english } = localeInfo();
  return `Language: answer in the language the user writes their request in. When the request has no clear language (a number, a name, a single word), answer in ${english}, the language the user reads Vunemi in. Write plans and handoff reasons in that same language.`;
}

// The Vault lives in a process of its own (vault-process/): it fetches the
// key from the Swift helper itself, and mail connects from there, so the key
// and the mail passwords are never in this process. Electron starts a
// utility process only once the app is ready, and this module must not wait
// for "ready" at the top level (an ESM main module delays "ready" until it
// has finished evaluating; awaiting it here deadlocks, measured 23 Sep). So
// the client reads as locked until then, and what needs a secret waits for
// `vaultReady`: the outbox, the MCP migration, the preference check.
const vaultHost = new VaultHost({
  spawn: () => utilityProcess.fork(join(here, "vault.js"), [], { serviceName: "Vunemi Vault", stdio: "inherit" }),
  init: () => ({ userData: app.getPath("userData"), helperPath, locale: getLocale() }),
  log: (line) => console.error(line),
});
const vault = vaultHost.client;
const vaultReady = vaultHost.ready;
void vaultReady.then(() => {
  // Names and errors only: diagnosable from the log, which never holds a value.
  for (const { name, reason } of vault.unreadable()) console.error(`[vunemi] vault: "${name}" unreadable: ${reason}`);
});

/**
 * The Vault masks every stored secret in text bound for the model. If it
 * can't be asked, text that might hold one is withheld rather than passed
 * on unchecked; with nothing stored there is nothing to mask.
 */
async function redact(text: string): Promise<string> {
  if (!text || vault.list().length === 0) return text;
  try {
    return await vault.redact(text);
  } catch {
    return "[Withheld: the Vault couldn't check this text for stored secrets. Try again in a moment.]";
  }
}
const preferences = new PreferenceStore(app.getPath("userData"), redact);
tools.register(rememberPreferenceTool(preferences));
void vaultReady.then(() => preferences.check());

/**
 * Secrets written by safeStorage, re-encrypted under the helper's key. Runs
 * once the app is ready, since safeStorage refuses before that — which is
 * after the connectors were built without them, so when anything moved the
 * app starts again, once, to build them with it. Bounded: if the keychain
 * will not answer, the entry stays as it is — kept, not lost — and is tried
 * again next launch.
 */
async function migrateLegacySecrets(): Promise<boolean> {
  if (!vault.available) return false;
  const legacy = (await vault.sealedEntries()).filter((entry) => isLegacyCipher(entry.cipher));
  if (legacy.length === 0) return false;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 8_000));
  let moved = false;
  await Promise.all(legacy.map(async (entry) => {
    try {
      const { result } = await Promise.race([safeStorage.decryptStringAsync(entry.cipher), timeout]);
      await vault.set(entry.name, result, entry.note);
      moved = true;
      console.error(`[vunemi] vault: "${entry.name}" moved to the new key`);
    } catch (err) {
      console.error(`[vunemi] vault: "${entry.name}" not moved, kept as it is: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
  return moved;
}
const OUTBOX_KEY = "outbox.queue";
/** The queue's key is only ever read back by the outbox itself. */
const OUTBOX_TARGET = "vunemi:outbox";
/** Where a queue saved before the rename is bound; read once, then saved under the new target. */
const LEGACY_OUTBOX_TARGET = "tenami:outbox";
const mailOutbox = new Outbox(HOLD_MS, {
  load: async () => {
    // A queue that can't be read yet must not be taken for an empty one:
    // the next send would write over it.
    if (!vault.available) throw new Error(t("vaultStore.locked"));
    if (vault.has(OUTBOX_KEY)) {
      await vault.adopt(OUTBOX_KEY, [OUTBOX_TARGET]);
      const target = vault.targets(OUTBOX_KEY).includes(LEGACY_OUTBOX_TARGET) ? LEGACY_OUTBOX_TARGET : OUTBOX_TARGET;
      const value: unknown = JSON.parse(await vault.use(OUTBOX_KEY, target));
      if (!Array.isArray(value)) throw new Error(t("main.outbox.unreadable"));
      return value as StoredSend[];
    }
    if (vault.list().some((item) => item.name === OUTBOX_KEY)) {
      throw new Error(t("main.outbox.undecryptable"));
    }
    return [];
  },
  save: async (messages) => {
    if (messages.length === 0) {
      if (vault.has(OUTBOX_KEY)) await vault.delete(OUTBOX_KEY);
    } else {
      await vault.set(OUTBOX_KEY, JSON.stringify(messages), t("main.outbox.vaultNote"), [OUTBOX_TARGET]);
    }
  },
});
const mailEvents: OutboxEvent[] = [];
mailOutbox.on((event) => {
  mailEvents.push(event);
  if (mailEvents.length > 100) mailEvents.shift();
  send(CH.outboxChanged, event);
  if (event.kind === "failed" && app.isReady() && Notification.isSupported()) {
    new Notification({ title: t("main.outbox.unverified") }).show();
  }
});
// Settings from before the Vault held MCP secrets: shown but not run until they are sealed.
const waitingForVault = new Set(settings.mcpServers.filter(unsealed).map((server) => server.id));
const appCatalog = new ScriptableCatalog(join(app.getPath("userData"), "apps"));
// Tasks the user scheduled from chat (see automations.ts).
const automations = new AutomationStore(join(app.getPath("userData"), "automations.json"));

const connectors = buildConnectors({
  automations,
  tools,
  browser,
  roots,
  appCatalog,
  shadowDir: join(app.getPath("userData"), "shadow"),
  helper,
  shotDir,
  remembered: settings.connections,
  onChange: (state) => settings.setConnections(state),
  mcpServers: settings.mcpServers,
  onMcpTools: rememberTools,
  mailAccounts: settings.mailAccounts,
  saveMailAccounts: (accounts) => settings.setMailAccounts(accounts),
  vault,
  vaultReady,
  mailOutbox,
  openOAuthBrowser: (url) => shell.openExternal(url),
});

// Sealed once the Vault can answer; then each such server runs from it. If
// this fails, they stay shown and blocked.
void vaultReady
  .then(async () => {
    if (waitingForVault.size === 0 || (await migrateMcpSecrets(settings, vault)) === 0) return;
    for (const server of settings.mcpServers) {
      if (!waitingForVault.has(server.id) || !server.secretRefs) continue;
      connectors.replace(createMcpConnector({ config: server, io: vaultMcpIO(vault, server), onTools: rememberTools }));
    }
  })
  .catch((err: unknown) => {
    console.error("[vunemi] MCP secrets migration failed:", err instanceof Error ? err.message : String(err));
  });

function rememberTools(id: string, discovered: McpTool[]): void {
  settings.setMcpServers(settings.mcpServers.map((s) => (s.id === id ? { ...s, tools: discovered } : s)));
}

/**
 * Turns what the user typed into a server description.
 *
 * The command line is split here rather than handed to a shell, for the same
 * reason `system_run` is argv-only: a shell turns one field into a place to
 * put `;` and everything after it.
 */
function describeServer(input: NewMcpServer, existing: McpServerConfig[]): McpServerConfig {
  const label = String(input?.label ?? "").trim();
  if (!label) throw new Error(t("main.mcp.needName"));

  const base = label.toLocaleLowerCase("tr").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
  let id = base;
  for (let n = 2; existing.some((s) => s.id === id) || RESERVED.has(id); n++) id = `${base}-${n}`;

  if (input?.kind === "http") {
    const url = String(input.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(t("main.mcp.needHttp"));
    return { id, label, transport: { kind: "http", url, ...(input.env && { headers: input.env }) } };
  }

  const parts = splitCommand(String(input?.command ?? ""));
  const [command, ...args] = parts;
  if (!command) throw new Error(t("main.mcp.needCommand"));
  return { id, label, transport: { kind: "stdio", command, args, ...(input?.env && { env: input.env }) } };
}

/** Built-in connection ids, so a server cannot take one of their names. */
const RESERVED = new Set(["browser", "files", "desktop", "calendar", "reminders", "mail", "core"]);

/** Splits a command line on spaces, honouring quotes. No shell involved. */
function splitCommand(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Secrets, kept by the system keychain and never shown to the model. The
 * agent may learn that "github-token" exists; the value stays on this side
 * of IPC, and `redact` masks it out of anything travelling the other way.
 */
// Hearing and speaking, both local: whisper.cpp on the GPU, macOS's own voice.
const voice = new Voice(app.getPath("userData"), {
  builtIn: whisperBinary({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, home: homedir() }),
  onChange: (status) => send(CH.voiceChanged, status),
});

const activity = new ActivityLog(app.getPath("userData"));
activity.onChange((entries) => send(CH.activityChanged, entries));

// What Vunemi made, kept longer than the activity log keeps clicks.
const artefacts = new ArtefactStore(app.getPath("userData"));

async function artefactViews(): Promise<ArtefactView[]> {
  return (await artefacts.list()).map((record) => {
    const item = record.item;
    const path = item.kind === "file" || item.kind === "download" ? item.path : null;
    const present = path !== null && existsSync(path);
    return {
      id: record.id,
      at: record.at,
      goal: record.goal,
      item,
      missing: path !== null && !present,
      canOpen: present && roots.allows(path) && openable(path),
      canReveal: present && roots.allows(path),
      canUndo: activity.canUndo(record.callId),
    };
  });
}
artefacts.onChange(() => void artefactViews().then((rows) => send(CH.artefactsChanged, rows)));

// A downloaded file is a change to this Mac like any other: it goes in the
// log, and one click puts it in the Trash.
embedded.onDownload((file) => {
  const id = activity.note({
    tool: "page_download",
    actionClass: "write-local",
    preview: t("main.download.preview", { name: file.name }),
    result: `${file.path} (${Math.max(1, Math.round(file.bytes / 1024))} KB) · ${file.url.slice(0, 200)}`,
    undo: {
      label: t("main.download.undo", { name: file.name }),
      fn: async () => {
        const trashed = join(app.getPath("home"), ".Trash", file.name);
        if (existsSync(file.path) && !existsSync(trashed)) renameSync(file.path, trashed);
      },
    },
  });
  artefacts.add(id, "page_download", [{ kind: "download", path: file.path }]);
});

const presence = new Presence(
  {
    show: showWindow,
    pause: () => session.pause(),
    // Pausing and stopping are always open; carrying on is the owner's call.
    resume: () => {
      if (appLock.isLocked) showWindow();
      else session.resume();
    },
    stop: () => session.stop(),
    emergencyStop: () => emergencyStop(),
    locked: () => appLock.isLocked,
  },
  () => win,
  app.isPackaged ? process.resourcesPath : join(here, "../../resources"),
);

// The single authority on what may run. The loop only asks and reports.
const grants = new Set<string>();
const sentinel = new Sentinel({ policy: settings.policy, grants });

// Kept conversations. "session" is the one the agent is working in; this is
// where it and the others are kept.
const conversations = new SessionStore(join(app.getPath("userData"), "sessions"));
// Projects: folders the user picked, each with its conversations. The
// current conversation's project is the first open folder.
const projects = new ProjectStore(join(app.getPath("userData"), "projects.json"));
const currentProject = () => projects.get(conversations.currentProject);
function syncProjectFolders(): void {
  roots.setProjects(projects.list().map((p) => p.folder), currentProject()?.folder ?? null);
}
syncProjectFolders();
const sessionList = (): SessionList => {
  const project = currentProject();
  return {
    current: conversations.currentId,
    sessions: conversations.list(),
    ...(project && { project: project.id }),
    projects: projects.views(),
  };
};

// Vunemi's own model server, for people with no model server of their own.
const engine: EngineService = new EngineService({
  dir: join(app.getPath("userData"), "engine"),
  binary: engineBinary({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, home: homedir() }),
  totalMemory: totalmem(),
  isBusy: () => session.running || session.queued.length > 0,
  testModel: async (spec, endpoint) => (await checkAgentModel(spec, settings.modelSettings, () => endpoint)).toolCalled,
  onChange: (view) => send(CH.engineChanged, view),
});

const session: AgentSession = new AgentSession({
  tools,
  emit: (event: AgentEvent) => {
    // Work keeps the engine loaded; the idle clock starts from the last of it.
    if (event.type === "run.started" || event.type === "run.finished") engine.touch();
    activity.record(event);
    artefacts.record(event);
    presence.record(event);
    conversations.record(event);
    send(CH.event, event);
  },
  onHistory: (history) => {
    conversations.setHistory(history);
    send(CH.sessionsChanged, sessionList());
  },
  onCheckpoint: (messages) => conversations.checkpoint(messages),
  // Read per run: a connection switched off mid-session stops being
  // described as well as stopping working.
  instructions: () =>
    [languageInstructions(), preferences.instructions(), connectors.instructions(), projectInstructions(currentProject(), connectors.isOn("files"), connectors.isOn("files") && connectors.isPartOn("files", "write"))]
      .filter(Boolean)
      .join("\n\n"),
  planBeforeRun: () => settings.planBeforeRun,
  modelConfig: (spec) => modelConfig(spec, settings.modelSettings, (s) => engine.endpoint(s)),
  prepareModel: (spec) => engine.prepare(spec),
  authorize: (req) => sentinel.check(req),
  // A part the user switched off comes back only through its card, and
  // only for a connection that is itself on.
  switchedOff: (tool) => connectors.partOf(tool),
  switchOn: (tool) => {
    const part = connectors.partOf(tool);
    if (part) connectors.setPartOn(part.connectorId, part.partId, true);
  },
  onUntrustedOutput: (text, tool) => sentinel.noteUntrusted(text, sourceOf(tool)),
  redact,
  loadImage: (path) => loadImage(path),
  readImageText: (path) => readImageText(path),
  grants,
  onUndoOffered: (u) => activity.offerUndo(u.callId, u.label, u.undo),
});

/** Where a tool's untrusted output came from, in words a card can show. */
function sourceOf(tool: string): string {
  if (tool === "files_read") return t("main.source.file");
  if (tool.startsWith("desktop_")) return t("main.source.window");
  if (!tool.startsWith("page_") && !tool.startsWith("tabs_")) return tool;
  const url = embedded.state.tabs.find((t) => t.id === embedded.state.activeId)?.url;
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : t("main.source.page");
  } catch {
    return t("main.source.page");
  }
}

/** Brings the window back, creating it again if the user closed it. */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#15120f",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win?.show());
  embedded.setHost(win);
  // Closing the window hides it: the run keeps going, its tabs stay alive,
  // and the menu bar remains. Quitting is what actually ends a run.
  win.on("close", (e) => {
    if (quitting || process.platform !== "darwin") return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });

  // The microphone, and nothing else: this window asks for no other device,
  // and the agent's own pages live in a different session that denies
  // everything. Electron doesn't always fill in mediaTypes, so the test is
  // "not video" rather than "exactly audio".
  const micOnly = (permission: string, details?: { mediaTypes?: string[] }): boolean =>
    (permission === "media" || permission === "audioCapture") && !details?.mediaTypes?.includes("video");

  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(micOnly(permission, details as { mediaTypes?: string[] }));
  });
  // getUserMedia consults this one before it even asks.
  win.webContents.session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    micOnly(permission, details as unknown as { mediaTypes?: string[] }),
  );

  // The renderer never navigates; anything that tries opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

handle(CH.listProviders, () => probeProviders(settings.modelSettings, engine.specs()));
handle(CH.modelSettingsGet, () => settings.modelSettings);
handle(CH.modelSettingsSet, (_e, input: unknown) => settings.setModelSettings(input as LocalModelSettings));
handle(CH.modelCheck, async (_e, spec: string) => {
  await engine.prepare(String(spec));
  const result = await checkAgentModel(String(spec), settings.modelSettings, (s) => engine.endpoint(s));
  engine.recordToolTest(String(spec), result.toolCalled);
  return result;
});
handle(CH.debugPortOpen, () => debugPortOpen);
handle(CH.engineGet, () => engine.view());
handle(CH.engineSearch, (_e, text: string) => engine.search(String(text)));
handle(CH.enginePopular, () => engine.popular());
handle(CH.engineInspect, (_e, repo: string) => engine.inspect(String(repo)));
handle(CH.engineDownload, (_e, req: unknown) => engine.download(downloadRequest(req)));
handle(CH.engineCancel, () => engine.cancel());
handle(CH.engineRemove, (_e, id: string) => engine.remove(String(id)));
handle(CH.engineAddLocal, async () => {
  // The path comes from the dialog the user answered, never from the window.
  const options = { title: t("engine.local.add"), filters: [{ name: "GGUF", extensions: ["gguf"] }], properties: ["openFile"] as "openFile"[] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return engine.addLocal(result.filePaths[0]);
});
handle(CH.engineWarm, (_e, spec: string) => engine.warm(String(spec)));
handle(CH.engineSetContext, async (_e, id: string, context: number) => {
  // The window the session remembered for this model is wrong now; forgotten
  // again once reloaded, in case it was asked in between.
  session.forgetWindow(`vunemi:${String(id)}`);
  await engine.setContext(String(id), Number(context));
  session.forgetWindow(`vunemi:${String(id)}`);
});

/** Only the three shapes, with string fields: the window is not trusted to send more. */
function downloadRequest(req: unknown): DownloadRequest {
  const r = (req ?? {}) as Record<string, unknown>;
  if (typeof r.catalog === "string") return { catalog: r.catalog };
  if (typeof r.repo === "string") return { repo: r.repo };
  if (r.resume === true) return { resume: true };
  if (typeof r.vision === "string") return { vision: r.vision };
  throw new Error("Bad download request");
}

// Fire and forget, both of these: progress arrives as events, not as the
// call's result. Whether the message runs now or waits its turn is the
// session's business, not the renderer's.
handle(CH.startRun, (_e, req: StartRunRequest) => {
  session.submit(String(req.goal), String(req.model), attach(req.attachments));
  automations.setModel(String(req.model));
});

handle(CH.steerRun, (_e, req: StartRunRequest) => {
  session.steer(String(req.goal), String(req.model), attach(req.attachments));
  automations.setModel(String(req.model));
});

/** An unanswered card in a scheduled task stops it after this long. */
const SCHEDULED_WAIT_MS = 30 * 60_000;

const automationViews = (): AutomationView[] => {
  const now = Date.now();
  return automations.list().map((item) => {
    const next = item.enabled ? nextSlot(item.schedule, Math.max(item.createdAt, item.lastSlot ?? 0), now) : null;
    return {
      id: item.id, title: item.title, task: item.task, when: describeSchedule(item.schedule), enabled: item.enabled,
      ...(next !== null && { next }),
      ...(item.lastRunAt !== undefined && { lastRunAt: item.lastRunAt }),
      ...(item.lastStatus && { lastStatus: item.lastStatus }),
    };
  });
};

const scheduler = new Scheduler({
  store: automations,
  now: Date.now,
  canStart: () => !appLock.isLocked && !session.running && session.queued.length === 0 && automations.model !== null,
  async run(item): Promise<AutomationStatus> {
    const model = automations.model;
    if (!model) return "noModel";
    // Its own conversation, so the task neither reads nor spills into the one the user had open.
    switchConversation([]);
    conversations.create(t("automations.conversation", { title: item.title }));
    syncProjectFolders();
    send(CH.sessionsChanged, sessionList());
    new Notification({ title: t("automations.notify"), body: appLock.isLocked ? "" : item.title }).show();
    // The user is not watching: say so, so the model neither waits for a reply nor mistakes old wording for new.
    const goal = scheduledGoal(item);
    const status = await session.start(goal, model, [], { unattended: true, waitLimitMs: SCHEDULED_WAIT_MS, ...(item.scope && { onlySources: item.scope }) });
    if (status === "done") {
      // What it found, where the user will see it; nothing of it while Vunemi is locked.
      const done = new Notification({ title: t("automations.finished", { title: item.title }), body: appLock.isLocked ? "" : summaryLine(session.lastAnswer) });
      done.on("click", showWindow);
      done.show();
    }
    return status === "done" ? "done" : status === "stopped" || status === "max_steps" ? "stopped" : "error";
  },
  onChange: () => send(CH.automationsChanged, automationViews()),
});
// A task switched off or deleted from chat shows in Settings at once.
automations.onChange = () => send(CH.automationsChanged, automationViews());

handle(CH.automationsList, () => automationViews());
handle(CH.automationsSet, (_e, id: string, enabled: boolean) => {
  automations.update(String(id), { enabled: enabled === true });
  return automationViews();
});
handle(CH.automationsSuggest, (_e, id: string) => {
  automations.add(suggestion(String(id)), Date.now());
  return automationViews();
});
handle(CH.automationsDelete, (_e, id: string) => {
  automations.remove(String(id));
  return automationViews();
});
handle(CH.automationsRun, (_e, id: string) => scheduler.runNow(String(id)));

/**
 * Files the user attached to a message become readable — each one alone,
 * read-only (Roots.grant). They are read with files_read, so the Files
 * connection has to be on; switched off, its tools do not exist and the
 * attachment would be a promise nobody can keep.
 */
function attach(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (!connectors.isOn("files")) {
    throw new Error(t("main.attach.filesOff"));
  }
  return paths.slice(0, 10).map((p) => roots.grant(String(p)));
}

handle(CH.pickFiles, async () => {
  const options = { title: t("composer.attach"), buttonLabel: t("composer.attach"), properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
});

handle(CH.dropQueued, (_e, id: string) => session.drop(String(id)));
handle(CH.interruptQueued, (_e, id: string) => session.interrupt(String(id)));
handle(CH.listQueued, () => session.queued);
session.onQueueChange((queue) => send(CH.queueChanged, queue));

handle(CH.stopRun, () => session.stop());
handle(CH.pauseRun, () => session.pause());
handle(CH.resumeRun, () => session.resume());
handle(CH.contextGet, (_e, model: string): Promise<ContextInfo> => session.contextInfo(String(model)));
handle(CH.contextCompact, (_e, model: string, runId: string) => session.compactNow(String(model), String(runId)));

/**
 * Stop, and cut the agent off the page right now rather than at the next
 * safe point: detaching the debugger fails whatever input is in flight.
 */
function emergencyStop(): void {
  // Nothing waiting may start on the back of an emergency: the point of the
  // shortcut is that everything halts, not that the next thing begins.
  session.clearQueue();
  session.stop();
  voice.stopSpeaking();
  embedded.release();
  showWindow();
}

handle(CH.resolveApproval, (_e, callId: string, decision: ApprovalDecision) => {
  session.resolveApproval(callId, decision);
});

handle(CH.resolveHandoff, (_e, callId: string, outcome: HandoffOutcome) => {
  session.resolveHandoff(callId, outcome === "done" ? "done" : "cancelled");
});

handle(CH.resolvePlan, (_e, decision: PlanDecision) => {
  if (decision?.kind === "go" && Array.isArray(decision.steps)) {
    session.resolvePlan({ kind: "go", steps: decision.steps.map(String).slice(0, 12) });
  } else {
    session.resolvePlan({ kind: "cancel" });
  }
});

/**
 * Moving to another conversation. Its "always" approvals and the page text
 * the Sentinel was tracking stay behind: what was allowed in one
 * conversation is not thereby allowed in the next.
 */
function switchConversation(history: Parameters<AgentSession["load"]>[0]): void {
  session.load(history); // throws while a task runs
  sentinel.reset();
}

/** After the current conversation changed: its project's folder comes first. */
function listAfterSwitch(): SessionList {
  syncProjectFolders();
  return sessionList();
}

handle(CH.sessionsList, () => sessionList());
handle(CH.sessionsNew, (_e, projectId?: string) => {
  const project = projects.get(typeof projectId === "string" ? projectId : undefined);
  switchConversation([]);
  conversations.create(undefined, project?.id);
  return listAfterSwitch();
});
handle(CH.sessionsOpen, (_e, id: string) => {
  if (session.running) throw new Error(t("main.stopFirst"));
  const { history, events } = conversations.open(String(id));
  switchConversation(history);
  return { ...listAfterSwitch(), events };
});
function forgetConversation(id: string): SessionList {
  const current = id === conversations.currentId;
  if (current) switchConversation([]);
  conversations.remove(id);
  return listAfterSwitch();
}

// A project starts with the user picking its folder in macOS's own dialog:
// the window can ask for one, it can't name one.
handle(CH.projectsAdd, async () => {
  if (session.running) throw new Error(t("main.stopFirst"));
  const options = {
    title: t("app.projects.pickTitle"),
    message: t("app.projects.pickMessage"),
    buttonLabel: t("app.projects.pickButton"),
    defaultPath: join(homedir(), "Documents"),
    properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const picked = result.canceled ? undefined : result.filePaths[0];
  if (!picked) return null;
  const problem = projectFolderProblem(picked, homedir(), [app.getPath("userData")]);
  if (problem) throw new Error(problem);
  const project = projects.add(realpathSync(picked));
  // Choosing a folder for Vunemi to work in, after a dialog that says it will
  // read and edit there, is the user switching Files and its writing on.
  if (!connectors.isOn("files")) connectors.setOn("files", true);
  if (!connectors.isPartOn("files", "write")) connectors.setPartOn("files", "write", true);
  switchConversation([]);
  conversations.create(undefined, project.id);
  return listAfterSwitch();
});
handle(CH.projectsRemove, (_e, id: string) => {
  if (session.running) throw new Error(t("main.stopFirst"));
  projects.remove(String(id));
  return listAfterSwitch();
});
handle(CH.projectsReveal, async (_e, id: string) => {
  const project = projects.get(String(id));
  if (project) await shell.openPath(project.folder);
});
handle(CH.sessionsDelete, (_e, id: string) => forgetConversation(String(id)));
// A task Vunemi's closing cut short. Picking it up is the user's call, and
// every step beyond reading asks again: the model may not know what the
// interrupted step already did.
handle(CH.sessionsResume, (_e, model: string) => {
  if (session.running) throw new Error(t("main.stopFirst"));
  if (!conversations.interrupted.includes(conversations.currentId)) return;
  void session.start(t("app.recovery.goal"), String(model), [], { askBeyondRead: true }).catch((err: unknown) => console.error("[vunemi] resume failed:", err));
});
handle(CH.sessionsDismiss, () => {
  conversations.dismissInterrupted();
  return sessionList();
});
// "Bu oturumu unut": the current conversation, gone.
handle(CH.resetSession, () => forgetConversation(conversations.currentId));
handle(CH.preferencesList, () => preferences.list());
handle(CH.preferencesDelete, (_e, id: string) => { preferences.remove(id); return preferences.list(); });
handle(CH.forgetEverything, async () => {
  if (session.running || mailOutbox.busy) {
    throw new Error(t("main.stopAndSettleFirst"));
  }
  await embedded.clearData();
  await activity.clear();
  await artefacts.clear();
  await vault.clear();
  preferences.clear();
  settings.reset();
  session.reset();
  sentinel.reset();
  conversations.clear();
  // Nothing may hold a model file open while it is deleted.
  await engine.dispose();
  for (const name of ["shots", "shadow", "models", "engine", "projects.json"]) {
    rmSync(join(app.getPath("userData"), name), { recursive: true, force: true });
  }
  mkdirSync(shotDir, { recursive: true });
  await win?.webContents.session.clearStorageData();
  await win?.webContents.session.clearCache();
  app.relaunch();
  setTimeout(() => app.quit(), 100);
});

handle(CH.lockGet, (): LockState => lockState());
handle(CH.lockUnlock, async (): Promise<LockAttempt> => {
  // A prompt behind the Mac's lock screen would only time out.
  if (macAway && appLock.isLocked) return lockAttempt({ ok: false, reason: "cancelled" });
  return lockAttempt(await appLock.unlock(t("lock.reason.open")));
});
handle(CH.lockSet, async (_e, on: unknown): Promise<LockAttempt> => {
  if (typeof on !== "boolean") throw new Error(t("lock.error.error"));
  const result = await appLock.setEnabled(on, t(on ? "lock.reason.turnOn" : "lock.reason.turnOff"), (next) => settings.setAppLock(next));
  send(CH.lockChanged, lockState());
  return lockAttempt(result);
});
appLock.onChange((locked) => {
  embedded.setCovered(locked);
  // Nothing private read aloud to an empty room; the window drops the
  // microphone when it hears the lock.
  if (locked) voice.stopSpeaking();
  presence.refresh();
  send(CH.lockChanged, lockState());
});
embedded.setCovered(appLock.isLocked);

handle(CH.languageGet, (): Locale => getLocale());
handle(CH.languageSet, (_e, next: unknown): Locale => {
  if (!isLocale(next)) throw new Error(t("main.badLanguage"));
  settings.setLanguage(next);
  setLocale(next);
  void vault.call("locale", [next]).catch(() => undefined);
  send(CH.languageChanged, next);
  return next;
});
handle(CH.policyGet, (): PermissionSettings => ({ policy: sentinel.currentPolicy, planBeforeRun: settings.planBeforeRun }));
handle(CH.policySet, (_e, next: PermissionSettings): PermissionSettings => {
  if (!validPolicy(next?.policy) || typeof next.planBeforeRun !== "boolean") throw new Error(t("main.invalidPolicy"));
  settings.setPolicy(next.policy, next.planBeforeRun);
  sentinel.setPolicy(next.policy);
  grants.clear();
  return { policy: sentinel.currentPolicy, planBeforeRun: settings.planBeforeRun };
});

handle(CH.connectionsList, () => connectors.list());
handle(CH.connectionsOn, () => connectors.onIds());

handle(CH.connectionsSet, async (_e, id: string, on: boolean) => {
  if (String(id) === "desktop" && on === true) await connectors.setOnIfReady("desktop");
  else connectors.setOn(String(id), on === true);
  return connectors.list();
});

handle(CH.connectionsSetPart, async (_e, id: string, partId: string, on: boolean) => {
  connectors.setPartOn(String(id), String(partId), on === true);
  return connectors.list();
});

handle(CH.connectionsConnect, async (_e, id: string) => {
  const status = await connectors.connect(String(id));
  if (status.state === "blocked") throw new Error(status.reason);
  return connectors.list();
});

// A fixed map, not a URL from the renderer: only these four panes open.
const PRIVACY_PANES: Record<string, string> = {
  calendars: "Privacy_Calendars",
  reminders: "Privacy_Reminders",
  accessibility: "Privacy_Accessibility",
  automation: "Privacy_Automation",
};
handle(CH.connectionsPrivacy, async (_e, pane: string) => {
  // Own keys only, or "constructor" would find Object's.
  const anchor = Object.hasOwn(PRIVACY_PANES, String(pane)) ? PRIVACY_PANES[String(pane)] : undefined;
  if (!anchor) throw new Error(t("main.unknownPane"));
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

handle(CH.connectionsDisconnect, async (_e, id: string) => {
  await connectors.disconnect(String(id));
  return connectors.list();
});

handle(CH.connectionsAddAccount, async (_e, id: string, provider: string, input?: MailAccountInput) => {
  await connectors.addAccount(String(id), String(provider), input);
  return connectors.list();
});

handle(CH.connectionsRemoveAccount, async (_e, id: string, accountId: string) => {
  await connectors.removeAccount(String(id), String(accountId));
  return connectors.list();
});
handle(CH.outboxList, () => ({ pending: mailOutbox.pending, uncertain: mailOutbox.uncertain, events: [...mailEvents] }));
handle(CH.outboxCancel, (_e, id: string) => mailOutbox.cancel(String(id)));
handle(CH.outboxDismiss, (_e, id: string) => mailOutbox.dismiss(String(id)));

/**
 * Adding an MCP server means running a program the user chose, or talking to
 * an address they gave. That is the widest thing this app does on someone's
 * say-so, which is exactly why it is here and not a tool: nothing the model
 * reads or writes can reach this handler.
 */
handle(CH.connectionsAddMcp, async (_e, input: NewMcpServer) => {
  try {
    const { stored, created } = await sealMcpServer(describeServer(input, settings.mcpServers), vault);
    try {
      // Checked once now, in the Vault process, so a secret that can't be
      // read back fails here, on screen.
      if (stored.secretRefs) await vault.call("mcp.check", [stored]);
      settings.setMcpServers([...settings.mcpServers, stored]);
      connectors.add(createMcpConnector({
        config: stored,
        ...(stored.secretRefs && { io: vaultMcpIO(vault, stored) }),
        onTools: rememberTools,
      }));
    } catch (err) {
      for (const name of created) await vault.delete(name).catch(() => undefined);
      throw err;
    }

    // Ask it what it can do straight away: a server that cannot start should
    // say so now, while the user is still looking at the screen.
    await connectors.connect(stored.id);
    return { ok: true as const, rows: await connectors.list() };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
});

handle(CH.connectionsRemove, async (_e, id: string) => {
  const wanted = String(id);
  const connector = connectors.get(wanted);
  // Only the user's own additions can be removed; the built-in ones are
  // switched off instead, and that distinction is not the renderer's to make.
  if (connector?.origin !== "mcp") throw new Error(t("main.cannotRemove"));
  await connectors.disconnect(wanted).catch(() => undefined);
  connectors.remove(wanted);
  const saved = settings.mcpServers;
  settings.setMcpServers(saved.filter((s) => s.id !== wanted));
  const removed = saved.find((s) => s.id === wanted);
  if (removed) await removeMcpSecrets(removed, vault);
  return connectors.list();
});

handle(CH.activityList, () => activity.list());
handle(CH.activityUndo, async (_e, id: string) => {
  const done = await activity.undo(String(id));
  artefacts.markUndone(String(id));
  // Undone in the conversation on screen: its model must not go on saying it happened.
  if (conversations.hasRun(done.runId)) session.noteUndone(done.label);
});

/**
 * The file behind an artefact, checked at the moment it is used. The path
 * comes from the record, never from the renderer; it is resolved to where it
 * really points, so a file later swapped for a link to something else is
 * judged by what it now is; and it must still be inside the open folders.
 */
async function artefactFile(id: string): Promise<string> {
  const item = (await artefacts.get(String(id)))?.item;
  if (!item || (item.kind !== "file" && item.kind !== "download")) throw new Error(t("main.artefact.notFile"));
  if (!existsSync(item.path)) throw new Error(t("main.artefact.missing"));
  const real = realpathSync(item.path);
  if (!roots.allows(real)) throw new Error(t("main.artefact.outside"));
  return real;
}

handle(CH.artefactsList, () => artefactViews());
handle(CH.artefactsOpen, async (_e, id: string) => {
  const file = await artefactFile(id);
  // Judged by the real file: a link named rapor.pdf may point at an app.
  if (!statSync(file).isFile() || !openable(file)) {
    throw new Error(t("main.artefact.notOpenable"));
  }
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
});
handle(CH.artefactsReveal, async (_e, id: string) => shell.showItemInFolder(await artefactFile(id)));
// Only opens the shortcut's editor; what runs is still decided on the card.
handle(CH.shortcutShow, (_e, name: string) =>
  new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/shortcuts", ["view", "--", shortcutName(name)], { timeout: 15_000 }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr).replace(/^Error:\s*/, "").trim() || err.message)) : resolve(),
    );
  }),
);
handle(CH.artefactsUndo, async (_e, id: string) => {
  const record = await artefacts.get(String(id));
  if (!record) throw new Error(t("main.artefact.notFound"));
  const done = await activity.undo(record.callId);
  artefacts.markUndone(record.callId);
  if (conversations.hasRun(done.runId)) session.noteUndone(done.label);
});

/**
 * Pictures the agent took, for the window that shows them. Only from the
 * folder Vunemi writes them to — the renderer may not ask for arbitrary files,
 * and a path that isn't one of ours is simply refused.
 */
handle(CH.readImage, (_e, path: string) => {
  const file = String(path);
  if (!file.startsWith(shotDir + "/") || !file.endsWith(".png")) throw new Error(t("main.cannotShow"));
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
});

handle(CH.voiceStatus, () => voice.status());
handle(CH.voiceDownload, async () => {
  try {
    return await voice.download();
  } catch (err) {
    if (err instanceof DownloadError) {
      if (err.code === "cancelled") return voice.status();
      throw new Error(t(`engine.error.${err.code}`, { size: `${((err.needed ?? 0) / 1e9).toFixed(1)} GB` }));
    }
    throw err;
  }
});
handle(CH.voiceDownloadCancel, () => voice.cancelDownload());
handle(CH.requestMic, async () => {
  // macOS asks the user once, and remembers; afterwards this is just a check.
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
});
handle(CH.transcribe, async (_e, wav: ArrayBuffer) => voice.transcribe(Buffer.from(wav)));
handle(CH.speak, (_e, text: string) => voice.speak(String(text)));
handle(CH.stopSpeaking, () => voice.stopSpeaking());

const vaultStatus = (): VaultStatus => ({ available: vault.available, secrets: vault.list() });
handle(CH.vaultStatus, () => vaultStatus());
handle(CH.vaultSet, async (_e, name: string, value: string, note?: string) => {
  await vault.set(String(name).trim(), String(value), note ? String(note).slice(0, 120) : undefined);
  return vaultStatus();
});
handle(CH.vaultDelete, async (_e, name: string) => {
  await vault.delete(String(name));
  return vaultStatus();
});

handle(CH.embeddedGet, () => embedded.state);
handle(CH.embeddedOpen, (_e, url: string) => void embedded.open(String(url)));
handle(CH.embeddedNavigate, (_e, id: string, url: string) => embedded.navigate(String(id), String(url)));
handle(CH.embeddedHistory, (_e, id: string, action: "back" | "forward" | "reload" | "stop") => {
  if (!["back", "forward", "reload", "stop"].includes(action)) throw new Error(`Unknown action: ${String(action)}`);
  embedded.history(String(id), action);
});
handle(CH.embeddedActivate, (_e, id: string) => embedded.activate(String(id)));
handle(CH.embeddedClose, (_e, id: string) => embedded.close(String(id)));
ipcMain.on(CH.embeddedBounds, (e, b: PaneBounds | null) => {
  if (e.sender !== win?.webContents) return;
  const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n) && n >= 0);
  embedded.setBounds(ok ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null);
});
embedded.onState((state) => send(CH.embeddedState, state));

/**
 * Opened from the disk image or Downloads: asks to move to Applications
 * before the Vault or anything else starts. Moving relaunches from there.
 */
async function offerMoveToApplications(): Promise<boolean> {
  const offer = shouldOfferMove({
    packaged: app.isPackaged,
    platform: process.platform,
    inApplications: app.isInApplicationsFolder(),
    testBuild: isLocalTestBuild(ownManifest()),
  });
  if (!offer) return false;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: t("main.moveApp.title"),
    detail: t("main.moveApp.detail"),
    buttons: [t("main.moveApp.move"), t("main.moveApp.later")],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    // An older Vunemi already there is replaced; one that is running is left alone.
    return app.moveToApplicationsFolder({ conflictHandler: (kind) => kind === "exists" });
  } catch (err) {
    dialog.showErrorBox("Vunemi", t("main.moveApp.failed", { reason: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}

void app.whenReady().then(async () => {
  if (await offerMoveToApplications()) return;
  void vaultHost.start();
  // Briefly, for the one-time migration below; a keychain prompt the user
  // hasn't answered yet must not keep the window from opening.
  await Promise.race([vaultReady, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (await migrateLegacySecrets()) {
    app.relaunch();
    app.exit(0);
    return;
  }
  createWindow();
  presence.start();
  // The Mac locking locks Vunemi too, when the user asked for a lock at all.
  powerMonitor.on("lock-screen", () => {
    macAway = true;
    appLock.lock();
    send(CH.lockChanged, lockState());
  });
  // Back at the Mac: now the window may ask.
  powerMonitor.on("unlock-screen", () => {
    macAway = false;
    send(CH.lockChanged, lockState());
  });
  if (!globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, emergencyStop)) {
    console.error(`[vunemi] could not register the emergency stop shortcut ${EMERGENCY_STOP_ACCELERATOR}`);
  }
  // The menu bar keeps Vunemi alive with no window, so runs continue.
  app.on("activate", () => showWindow());
  // Scheduled tasks: checked every half minute, and straight after the Mac wakes.
  setInterval(() => scheduler.tick(), 30_000);
  powerMonitor.on("resume", () => scheduler.tick());
  scheduler.tick();
});

app.on("before-quit", (e) => {
  if (quitting) return;
  // Let go of the pages cleanly before the window goes.
  quitting = true;
  e.preventDefault();
  session.stop();
  void Promise.allSettled([browser.dispose(), mailOutbox.settle(), engine.dispose()]).finally(() => app.quit());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  presence.dispose();
  voice.dispose();
  helper.dispose();
  vaultHost.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
