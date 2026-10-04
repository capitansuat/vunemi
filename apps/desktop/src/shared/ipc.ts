/**
 * The IPC contract between main, preload and renderer. Types only — each side
 * imports these so a channel can't drift out of sync with its handler.
 */

import type { ActionClass, AgentEvent, ApprovalDecision, AutonomyPolicy, HandoffOutcome, PlanDecision, Produced, ProviderKind } from "@vunemi/agent-core";
import type { ConnectorView, PrivacyPane } from "@vunemi/connectors";
import type { OutboxEvent, Pending, UncertainSend } from "@vunemi/mail";
import type { Locale } from "@vunemi/i18n";

export type { ConnectorView, PrivacyPane };

/** What the connections screen collects before a server can be added. */
export interface NewMcpServer {
  label: string;
  /** A command to run, or an https URL to talk to. */
  kind: "stdio" | "http";
  /** For stdio: the whole command line, e.g. `npx -y @some/mcp-server`. */
  command?: string;
  /** For http. */
  url?: string;
  /** Header or environment values, as the user typed them. */
  env?: Record<string, string>;
}

/** A kept conversation, as the sidebar lists it. */
export interface SessionSummary {
  id: string;
  /** The first task, in the user's words. */
  title: string;
  updatedAt: number;
  /** Tasks run in it. */
  runs: number;
  /** Its last task was cut short when Vunemi closed: steps it finished, and when. */
  interrupted?: { steps: number; at: number };
  /** The project it belongs to, if any. */
  projectId?: string;
}

/** A project as the sidebar shows it. */
export interface ProjectView {
  id: string;
  name: string;
  /** Where it is, with ~ for the home folder. */
  folder: string;
  /** The folder has been moved or deleted since. */
  missing: boolean;
}

/** A scheduled task as the settings list shows it; `when` is already in the user's language. */
export interface AutomationView {
  id: string;
  title: string;
  task: string;
  when: string;
  enabled: boolean;
  next?: number;
  lastRunAt?: number;
  lastStatus?: "done" | "stopped" | "error" | "missed" | "noModel";
}

export interface SessionList {
  /** The conversation new tasks go into. May not be listed yet: an empty one is not kept. */
  current: string;
  sessions: SessionSummary[];
  /** The project the current conversation works in, if any. */
  project?: string;
  projects: ProjectView[];
}

export interface MailAppAccount {
  name: string;
  emails: string[];
  connected: boolean;
}

export interface MailAccountInput {
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  user: string;
  password: string;
  clientId?: string;
}

export interface PermissionSettings {
  policy: AutonomyPolicy;
  planBeforeRun: boolean;
}

/**
 * A secret as the rest of the app may see it: a name, and what it's for.
 * Declared here rather than imported from @vunemi/vault so the renderer never
 * pulls in the module that can actually decrypt anything.
 */
export interface SecretInfo {
  name: string;
  note?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** Whether this Mac can hear and speak, and what to do if it can't. */
export interface VoiceStatus {
  canHear: boolean;
  canSpeak: boolean;
  engine: string;
  hint?: string;
  /** No speech model yet, and Vunemi can download one: its size in bytes. */
  download?: { bytes: number };
  /** That download, while it runs. */
  downloading?: { received: number; total: number };
}

/** What the Vault can tell the UI. Values are never part of this. */
export interface VaultStatus {
  /** False when this Mac has no secure storage, so nothing may be saved. */
  available: boolean;
  secrets: SecretInfo[];
}

export interface ProviderStatus {
  kind: ProviderKind;
  baseUrl: string;
  reachable: boolean;
  /** Full specs, e.g. `lmstudio:qwen/qwen3.6-35b-a3b`. */
  models: string[];
  error?: string;
}

export interface LocalModelSettings {
  endpoints: { lmstudio: string; ollama: string; llamacpp: string };
  ollamaContextLength: number;
}

export interface ModelCheckResult {
  toolCalled: boolean;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ActivityEntry {
  /** The tool call's id. */
  id: string;
  at: number;
  runId: string;
  /** The task this was part of. */
  goal: string;
  tool: string;
  actionClass: ActionClass;
  status: "running" | "waiting-user" | "ok" | "error" | "refused";
  preview?: string;
  result?: string;
  durationMs?: number;
  /** Label of the undo a tool offered, while it is still available. */
  undo?: string;
  undone?: boolean;
}

/**
 * One row of the Artefacts screen. The renderer gets what it needs to draw
 * and which buttons to offer — never a path to hand back. Opening names the
 * artefact by id, and main looks the path up and checks it again.
 */
export interface ArtefactView {
  id: string;
  at: number;
  goal: string;
  item: Produced;
  /** A file or download that is no longer where it was made. */
  missing: boolean;
  /** Opens with its default app: a document, a picture, media. */
  canOpen: boolean;
  /** Can be shown in Finder. */
  canReveal: boolean;
  /** A web page: shown beside the chat, offline. */
  canPreview: boolean;
  /** Its undo is still held (this session only). */
  canUndo: boolean;
}

/** Works from anywhere, even when Vunemi isn't focused. */
export const EMERGENCY_STOP_ACCELERATOR = "CommandOrControl+Shift+Escape";

/** How big a request the model takes, and how much of it the next one would use. */
export interface ContextInfo {
  window: number;
  /** False when the server didn't say and the window is Vunemi's assumption. */
  known: boolean;
  estimate: number;
}

export interface LockState {
  enabled: boolean;
  locked: boolean;
  /** The Mac's own lock screen is up, so there is nobody to ask yet. */
  away: boolean;
}

/** What macOS said. The message, when there is one, is already in the user's language. */
export type LockAttempt = { ok: true; state: LockState } | { ok: false; state: LockState; message: string | null };

export interface StartRunRequest {
  goal: string;
  model: string;
  /** Files the user attached: dropped on the window or picked. */
  attachments?: string[];
}

export interface EmbeddedTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The agent is attached to this tab. */
  agent: boolean;
  /**
   * The page was refused as a private-network address. `trustable` is false
   * for this Mac's own addresses, which can't be trusted.
   */
  blocked: { host: string; trustable: boolean } | null;
}

export interface EmbeddedState {
  tabs: EmbeddedTab[];
  activeId: string | null;
}

export type TrustedSiteResult =
  | { ok: true; sites: string[]; host: string }
  | { ok: false; reason: "invalid" | "this-computer" | "full" };

/** The browser pane's rectangle in window coordinates (CSS px). */
export interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A message the user sent while the agent was busy. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: string[];
  model: string;
  at: number;
}

// -- the built-in engine -----------------------------------------------------

export type EngineStateName = "absent" | "idle" | "starting" | "ready" | "failed";
export interface CatalogView { id: string; name: string; size: number; license: string }
export interface InstalledView {
  id: string;
  name: string;
  size: number;
  license: string;
  /** The context length the model loads with. */
  context: number;
  /** The longest the setting allows: what the model was trained for, or this Mac's default when the file does not say. */
  maxContext: number;
  /** Sees images; can be given its vision part; or has none. */
  vision: "yes" | "add" | "no";
  /** Bytes the model takes loaded, before any context: weights and vision part. */
  weights: number;
  /** How much the context's memory grows per token, from the model file; absent when it doesn't say. */
  kvBytesPerToken?: number;
  /** The vision part's size, when it can be added and is known. */
  visionSize?: number;
  toolTest?: "ok" | "failed";
}
export interface DownloadView {
  id: string;
  name: string;
  received: number;
  total: number;
  bytesPerSecond: number;
  state: "downloading" | "paused" | "testing";
  /** Only the vision part of an installed model. */
  vision?: true;
}
export interface EngineView {
  available: boolean;
  /** This Mac's memory, for the context length's estimate. */
  totalMemory: number;
  engine: { state: EngineStateName; model: string | null; error?: string };
  recommended: CatalogView;
  /** The recommendation first, then each smaller model, one step at a time. */
  choices: CatalogView[];
  installed: InstalledView[];
  download: DownloadView | null;
}
/** A popular model on Hugging Face that fits this Mac and can use tools. */
export interface PopularView { id: string; repo: string; maker: string; name: string; likes: number; license: string; size: number }
export interface SearchHitView { repo: string; author: string; downloads: number; trusted: boolean }
export type InspectView =
  | { ok: true; repo: string; name: string; license: string; size: number }
  | { ok: false; repo: string; reason: "gated" | "license" | "tooBig" | "noFile" | "notFound" };
export type DownloadRequest = { catalog: string } | { repo: string } | { resume: true } | { vision: string };

/** A work note, for the project's notes view and the timeline's delete. */
export interface WorkNoteView {
  id: string;
  title: string;
  text: string;
  sources: string[];
  updatedAt: number;
}

/** A local model server the model manager measures and may stop. */
export type ResidentId = "chat" | "meaning" | "voice";

/** The model manager's last decision, for the models page. */
export type ModelsDecision =
  | { at: number; kind: "unloaded"; ids: ResidentId[] }
  | { at: number; kind: "lowered"; context: number; wanted: number };

/** "Now in memory" on the models page. Bytes are null when they could not be measured. */
export interface ModelsMemoryView {
  total: number;
  available: number | null;
  residents: { id: ResidentId; loaded: boolean; bytes: number | null }[];
  last: ModelsDecision | null;
}

/** A note in memory, with the user's own words it came from. */
export interface MemoryNoteView {
  id: string;
  text: string;
  kind: "general" | "topic";
  createdAt: number;
  updatedAt: number;
  givenAt: number | null;
  confirmed: number;
  /** `sessionId` is null for a note moved from the old Preferences list. */
  evidence: { quote: string; sessionId: string | null; at: number }[];
}

/** Search by meaning: its model, and whether it is here. */
export type MemorySearchStatus =
  | { state: "unavailable" }
  | { state: "absent"; bytes: number }
  | { state: "downloading"; bytes: number; received: number }
  | { state: "ready"; bytes: number };

/** One stretch of a meeting, written down. Seconds from the start of the recording. */
export interface MeetingLine {
  source: "me" | "others";
  start: number;
  end: number;
  text: string;
}

export type MeetingState = "recording" | "transcribing" | "summarising" | "done" | "failed";

export interface MeetingSummaryView {
  id: string;
  /** Empty until named; the window shows the date instead. */
  title: string;
  startedAt: number;
  endedAt: number | null;
  language: string | null;
  /** Markdown in the fixed template; null for a meeting nobody spoke in. */
  summary: string | null;
  state: MeetingState;
  /** Already in words, for a failed meeting. */
  error?: string;
}

export interface MeetingView extends MeetingSummaryView {
  lines: MeetingLine[];
}

export interface MeetingStatusView {
  recording: { id: string; startedAt: number; lines: MeetingLine[]; pending: number } | null;
  /** Why the Record button cannot record, in words; null when it can. */
  blocked: string | null;
}

export interface MicrophoneView {
  id: string;
  name: string;
  default: boolean;
}

/** Light or dark: the Mac's choice unless the user makes one. */
export type Appearance = "system" | "light" | "dark";

/** Why an update could not be had: no answer, an answer we could not use, a failed download, or a foreign signature. */
export type UpdateError = "network" | "feed" | "download" | "signature";

export interface UpdateStatus {
  /** "current": a manual check found nothing newer. */
  phase: "idle" | "current" | "available" | "downloading" | "ready" | "failed";
  offer: { version: string; notes: string[]; sizeMb: number | null } | null;
  error: UpdateError | null;
  checkedAt: number | null;
  /** Vunemi runs from Applications, where it can replace itself. */
  installable: boolean;
  /** Nothing is running that a restart would cut short. */
  idle: boolean;
}

/** Exposed on `window.vunemi` by the preload script. */
export interface VunemiApi {
  listProviders(): Promise<ProviderStatus[]>;
  getModelSettings(): Promise<LocalModelSettings>;
  setModelSettings(settings: LocalModelSettings): Promise<LocalModelSettings>;
  checkModel(spec: string): Promise<ModelCheckResult>;
  /**
   * Send a message. It starts at once if the agent is idle and waits its turn
   * if it isn't, so the composer never has to be disabled.
   */
  startRun(req: StartRunRequest): Promise<void>;
  /** The open panel, for attaching files. Empty when cancelled. */
  pickFiles(): Promise<string[]>;
  /** The path of a file dropped on the window. */
  pathForFile(file: File): string;
  /** Stop what the agent is doing and take this message next. */
  steerRun(req: StartRunRequest): Promise<void>;
  /** Take a waiting message back out of the queue. */
  dropQueued(id: string): Promise<void>;
  /** A waiting message that can't wait: stop the current task and do this now. */
  interruptQueued(id: string): Promise<void>;
  listQueued(): Promise<QueuedMessage[]>;
  onQueue(listener: (queue: QueuedMessage[]) => void): () => void;
  stopRun(): Promise<void>;
  /** Hold the run at its next safe point, so the user can look or take over the page. */
  pauseRun(): Promise<void>;
  resumeRun(): Promise<void>;
  resolveApproval(callId: string, decision: ApprovalDecision): Promise<void>;
  /** The user accepted, edited or cancelled the intent preview. */
  resolvePlan(decision: PlanDecision): Promise<void>;
  /** The user finished (or gave up on) a step the agent handed to them. */
  resolveHandoff(callId: string, outcome: HandoffOutcome): Promise<void>;
  /** Forgets the current conversation and starts a fresh one. */
  resetSession(): Promise<SessionList>;
  /** The chosen model's window and the conversation's size in it. */
  getContext(model: string): Promise<ContextInfo>;
  /** Condenses the earlier part of the conversation now; `runId` is the run the row goes under. */
  compactNow(model: string, runId: string): Promise<void>;
  listSessions(): Promise<SessionList>;
  /** A fresh conversation, in a project if one is given; the current one stays in the list. */
  newSession(projectId?: string): Promise<SessionList>;
  /** The user picks a folder for a new project; null when they cancel. Starts a conversation in it. */
  addProject(): Promise<SessionList | null>;
  /** Forgets a project; its folder and conversations stay. */
  removeProject(id: string): Promise<SessionList>;
  /** Shows the project's folder in Finder. */
  revealProject(id: string): Promise<void>;
  /** Continues a kept conversation; its events rebuild the timeline. */
  openSession(id: string): Promise<SessionList & { events: AgentEvent[] }>;
  deleteSession(id: string): Promise<SessionList>;
  renameSession(id: string, title: string): Promise<SessionList>;
  /** Picks up the current conversation's cut-short task; every step beyond reading asks. */
  resumeInterrupted(model: string): Promise<void>;
  /** Lets the cut-short task go; the conversation stays. */
  dismissInterrupted(): Promise<SessionList>;
  onSessions(listener: (list: SessionList) => void): () => void;
  listMemory(): Promise<MemoryNoteView[]>;
  updateMemory(id: string, text: string): Promise<MemoryNoteView[]>;
  deleteMemory(id: string): Promise<MemoryNoteView[]>;
  forgetMemory(): Promise<MemoryNoteView[]>;
  listWorkNotes(scope: { projectId?: string; conversationId?: string }): Promise<WorkNoteView[]>;
  deleteWorkNote(id: string, scope: { projectId?: string; conversationId?: string }): Promise<WorkNoteView[]>;
  /** The user's answer to a note proposed under a reply; `text` when they edited it. */
  resolveMemory(runId: string, proposalId: string, decision: "saved" | "skipped", text?: string): Promise<void>;
  memorySearch(): Promise<MemorySearchStatus>;
  memorySearchDownload(): Promise<MemorySearchStatus>;
  memorySearchCancel(): Promise<void>;
  onMemorySearch(listener: (status: MemorySearchStatus) => void): () => void;
  /** Newest first; with a query, only the meetings whose title, summary or words match. */
  meetingsList(query?: string): Promise<MeetingSummaryView[]>;
  meetingsGet(id: string): Promise<MeetingView | null>;
  meetingsStatus(): Promise<MeetingStatusView>;
  /** Only ever from the user's button. */
  meetingsStart(microphone?: string): Promise<MeetingStatusView>;
  /** Stops recording; `model` writes the summary. Resolves when the meeting is finished. */
  meetingsStop(model: string | null): Promise<void>;
  meetingsRetry(id: string, model: string | null): Promise<void>;
  /** Finishes meetings Vunemi quit during; the window calls it once it knows the model. */
  meetingsRecover(model: string | null): Promise<void>;
  meetingsRename(id: string, title: string): Promise<MeetingSummaryView[]>;
  /** To the Trash. */
  meetingsDelete(id: string): Promise<MeetingSummaryView[]>;
  meetingsExport(id: string): Promise<boolean>;
  meetingsLevels(): Promise<{ me: number; others: number }>;
  meetingsDevices(): Promise<MicrophoneView[]>;
  onMeetings(listener: (status: MeetingStatusView) => void): () => void;
  onMeetingLine(listener: (id: string, line: MeetingLine) => void): () => void;
  forgetEverything(): Promise<void>;
  /** This copy's version, shown so the user knows which one runs. */
  appVersion(): Promise<string>;
  reportProblem(): Promise<void>;
  updatesStatus(): Promise<UpdateStatus>;
  checkUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  getUpdatesAuto(): Promise<boolean>;
  setUpdatesAuto(on: boolean): Promise<boolean>;
  onUpdates(listener: (status: UpdateStatus) => void): () => void;
  getAppearance(): Promise<Appearance>;
  setAppearance(appearance: Appearance): Promise<Appearance>;
  /** The language Vunemi speaks; main keeps it, the window follows. */
  getLanguage(): Promise<Locale>;
  setLanguage(locale: Locale): Promise<Locale>;
  onLanguage(listener: (locale: Locale) => void): () => void;
  /**
   * The optional app lock. `enabled` is the setting; `locked` is whether the
   * window may be used right now. Unlocking and switching the setting both
   * show macOS's own Touch ID / password dialog.
   */
  getLock(): Promise<LockState>;
  unlock(): Promise<LockAttempt>;
  setAppLock(on: boolean): Promise<LockAttempt>;
  /**
   * Private-network sites the browser may open, added only here by the
   * user. Adding says why a host was refused rather than throwing.
   */
  getTrustedSites(): Promise<string[]>;
  addTrustedSite(raw: string): Promise<TrustedSiteResult>;
  removeTrustedSite(host: string): Promise<string[]>;
  onLock(listener: (state: LockState) => void): () => void;
  getPolicy(): Promise<PermissionSettings>;
  setPolicy(settings: PermissionSettings): Promise<PermissionSettings>;
  onEvent(listener: (event: AgentEvent) => void): () => void;

  /** Everything Vunemi can reach, and whether the user has it switched on. */
  listConnections(): Promise<ConnectorView[]>;
  /** Ids of the connections switched on. Cheap: asks nothing of them, unlike listConnections. */
  connectionsOn(): Promise<string[]>;
  setConnection(id: string, on: boolean): Promise<ConnectorView[]>;
  /** Switches one part of a connection — reading without writing, say. */
  setConnectionPart(id: string, partId: string, on: boolean): Promise<ConnectorView[]>;
  /** Runs that connection's own permission prompt or sign-in. */
  connectConnection(id: string): Promise<ConnectorView[]>;
  /** Opens System Settings at the Privacy & Security pane that grants it. */
  openPrivacySettings(pane: PrivacyPane): Promise<void>;
  disconnectConnection(id: string): Promise<ConnectorView[]>;
  /** Adds an account to a connection that holds several, e.g. a second mailbox. */
  addAccount(id: string, provider: string, input?: MailAccountInput | { account: string }): Promise<ConnectorView[]>;
  removeAccount(id: string, accountId: string): Promise<ConnectorView[]>;
  /** The accounts the Mac's Mail app has enabled, and whether each is connected already. */
  mailAppAccounts(): Promise<MailAppAccount[]>;
  listOutbox(): Promise<{ pending: Pending[]; uncertain: UncertainSend[]; events: OutboxEvent[] }>;
  cancelOutbox(id: string): Promise<boolean>;
  dismissOutbox(id: string): Promise<boolean>;
  onOutbox(listener: (event: OutboxEvent) => void): () => void;
  /**
   * Adds an MCP server the user configured. Only ever called from the
   * connections screen: there is deliberately no tool for this.
   */
  addMcpServer(server: NewMcpServer): Promise<{ ok: true; rows: ConnectorView[] } | { ok: false; error: string }>;
  removeConnection(id: string): Promise<ConnectorView[]>;

  listActivity(): Promise<ActivityEntry[]>;
  undoActivity(id: string): Promise<void>;
  onActivity(listener: (entries: ActivityEntry[]) => void): () => void;

  listAutomations(): Promise<AutomationView[]>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationView[]>;
  /** Adds one of Vunemi's suggested tasks; the user pressed its button. */
  addSuggestedAutomation(id: "awaiting-reply" | "morning-brief"): Promise<AutomationView[]>;
  deleteAutomation(id: string): Promise<AutomationView[]>;
  /** False when it can't start now (a task is running, Vunemi is locked, no model yet). */
  runAutomation(id: string): Promise<boolean>;
  onAutomations(listener: (rows: AutomationView[]) => void): () => void;

  listArtefacts(): Promise<ArtefactView[]>;
  openArtefact(id: string): Promise<void>;
  /** A page Vunemi made, beside the chat, cut off from the internet. Returns the file's name. */
  previewArtefact(id: string): Promise<string>;
  previewBounds(bounds: PaneBounds | null): void;
  previewClose(): void;
  revealArtefact(id: string): Promise<void>;
  /** Opens a shortcut in the Shortcuts app, so the user can see its steps before approving a run. */
  showShortcut(name: string): Promise<void>;
  undoArtefact(id: string): Promise<void>;
  onArtefacts(listener: (rows: ArtefactView[]) => void): () => void;

  /** Names and notes only — a secret's value never crosses this boundary. */
  vaultStatus(): Promise<VaultStatus>;
  vaultSet(name: string, value: string, note?: string): Promise<VaultStatus>;
  vaultDelete(name: string): Promise<VaultStatus>;

  /** A picture a tool attached, as a data URL. Only from Vunemi's own folder. */
  readImage(path: string): Promise<string>;
  /** Microphone and speech. Audio never leaves this Mac. */
  voiceStatus(): Promise<VoiceStatus>;
  /** Downloads the speech model; resolves when it is ready to use. */
  voiceDownload(): Promise<VoiceStatus>;
  voiceDownloadCancel(): Promise<void>;
  /** Progress of the speech model download, and its end. */
  onVoiceStatus(listener: (status: VoiceStatus) => void): () => void;
  /** Asks macOS for the microphone, once, on a click the user made. */
  requestMic(): Promise<boolean>;
  /** 16 kHz mono WAV bytes in, transcript out. */
  transcribe(wav: ArrayBuffer): Promise<string>;
  /** Resolves when the voice stops, so the UI knows whose turn it is. */
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;

  getEmbedded(): Promise<EmbeddedState>;
  embeddedOpen(url: string): Promise<void>;
  /** A travel card's offer, in the pane; Google's cookie question there is declined. */
  travelOpen(url: string): Promise<void>;
  embeddedNavigate(id: string, url: string): Promise<void>;
  embeddedHistory(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  embeddedActivate(id: string): Promise<void>;
  embeddedClose(id: string): Promise<void>;
  /** Where to draw the page; null hides it (pane closed). */
  embeddedBounds(bounds: PaneBounds | null): void;
  onEmbeddedState(listener: (state: EmbeddedState) => void): () => void;

  /** The built-in engine: what it offers, what is downloaded, what runs. */
  getEngine(): Promise<EngineView>;
  onEngine(listener: (view: EngineView) => void): () => void;
  engineSearch(text: string): Promise<SearchHitView[]>;
  /** Asks Hugging Face at most once a day; empty when it cannot be reached. */
  enginePopular(): Promise<PopularView[]>;
  engineInspect(repo: string): Promise<InspectView>;
  /** Resolves when the download (and its tool test) is over: the new spec, or null if cancelled. */
  engineDownload(req: DownloadRequest): Promise<string | null>;
  engineCancel(): Promise<void>;
  engineRemove(id: string): Promise<void>;
  /** Whether this run was started with remote debugging open (a local test build). */
  debugPortOpen(): Promise<boolean>;
  /** Asks for a GGUF file on this Mac and adds it; null when the user cancelled. */
  engineAddLocal(): Promise<string | null>;
  /** Loads a `vunemi:` model in the background; other specs are ignored. */
  engineWarm(spec: string): Promise<void>;
  engineSetContext(id: string, context: number): Promise<void>;
}

export const CH = {
  listProviders: "providers:list",
  modelSettingsGet: "providers:settings-get",
  modelSettingsSet: "providers:settings-set",
  modelCheck: "providers:check",
  startRun: "run:start",
  pickFiles: "files:pick",
  steerRun: "run:steer",
  dropQueued: "run:drop-queued",
  interruptQueued: "run:interrupt-queued",
  listQueued: "run:list-queued",
  queueChanged: "run:queue-changed",
  stopRun: "run:stop",
  pauseRun: "run:pause",
  resumeRun: "run:resume",
  resolveApproval: "approval:resolve",
  resolveHandoff: "handoff:resolve",
  resolvePlan: "plan:resolve",
  resetSession: "session:reset",
  contextGet: "context:get",
  contextCompact: "context:compact",
  sessionsList: "sessions:list",
  sessionsNew: "sessions:new",
  projectsAdd: "projects:add",
  projectsRemove: "projects:remove",
  projectsReveal: "projects:reveal",
  sessionsOpen: "sessions:open",
  sessionsDelete: "sessions:delete",
  sessionsRename: "sessions:rename",
  sessionsChanged: "sessions:changed",
  memoryList: "memory:list",
  memoryUpdate: "memory:update",
  memoryDelete: "memory:delete",
  memoryForget: "memory:forget",
  workNotesList: "workNotes:list",
  workNotesDelete: "workNotes:delete",
  memoryResolve: "memory:resolve",
  memorySearch: "memory:search",
  memorySearchDownload: "memory:search-download",
  memorySearchCancel: "memory:search-cancel",
  memorySearchChanged: "memory:search-changed",
  meetingsList: "meetings:list",
  meetingsGet: "meetings:get",
  meetingsStatus: "meetings:status",
  meetingsStart: "meetings:start",
  meetingsStop: "meetings:stop",
  meetingsRetry: "meetings:retry",
  meetingsRecover: "meetings:recover",
  meetingsRename: "meetings:rename",
  meetingsDelete: "meetings:delete",
  meetingsExport: "meetings:export",
  meetingsLevels: "meetings:levels",
  meetingsDevices: "meetings:devices",
  meetingsChanged: "meetings:changed",
  meetingsLine: "meetings:line",
  forgetEverything: "data:forget-everything",
  appVersion: "app:version",
  reportProblem: "app:report-problem",
  updatesStatus: "updates:status",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesInstall: "updates:install",
  updatesAutoGet: "updates:auto-get",
  updatesAutoSet: "updates:auto-set",
  updatesChanged: "updates:changed",
  appearanceGet: "appearance:get",
  appearanceSet: "appearance:set",
  languageGet: "language:get",
  languageSet: "language:set",
  languageChanged: "language:changed",
  lockGet: "lock:get",
  lockUnlock: "lock:unlock",
  lockSet: "lock:set",
  lockChanged: "lock:changed",
  trustedSitesGet: "trusted-sites:get",
  trustedSitesAdd: "trusted-sites:add",
  trustedSitesRemove: "trusted-sites:remove",
  policyGet: "policy:get",
  policySet: "policy:set",
  event: "agent:event",
  connectionsList: "connections:list",
  connectionsOn: "connections:on",
  connectionsSet: "connections:set",
  connectionsSetPart: "connections:set-part",
  connectionsConnect: "connections:connect",
  connectionsPrivacy: "connections:privacy",
  connectionsDisconnect: "connections:disconnect",
  connectionsAddAccount: "connections:add-account",
  connectionsRemoveAccount: "connections:remove-account",
  mailAppAccounts: "connections:mail-app-accounts",
  outboxList: "outbox:list",
  outboxCancel: "outbox:cancel",
  outboxDismiss: "outbox:dismiss",
  outboxChanged: "outbox:changed",
  connectionsAddMcp: "connections:add-mcp",
  connectionsRemove: "connections:remove",
  activityList: "activity:list",
  activityUndo: "activity:undo",
  activityChanged: "activity:changed",
  artefactsList: "artefacts:list",
  artefactsOpen: "artefacts:open",
  artefactsPreview: "artefacts:preview",
  previewBounds: "preview:bounds",
  previewClose: "preview:close",
  artefactsReveal: "artefacts:reveal",
  shortcutShow: "shortcuts:show",
  sessionsResume: "sessions:resume",
  sessionsDismiss: "sessions:dismiss",
  artefactsUndo: "artefacts:undo",
  artefactsChanged: "artefacts:changed",
  automationsList: "automations:list",
  automationsSet: "automations:set",
  automationsSuggest: "automations:suggest",
  automationsDelete: "automations:delete",
  automationsRun: "automations:run",
  automationsChanged: "automations:changed",
  readImage: "artifact:image",
  voiceStatus: "voice:status",
  voiceDownload: "voice:download",
  voiceDownloadCancel: "voice:download-cancel",
  voiceChanged: "voice:changed",
  requestMic: "voice:request-mic",
  transcribe: "voice:transcribe",
  speak: "voice:speak",
  stopSpeaking: "voice:stop-speaking",
  vaultStatus: "vault:status",
  vaultSet: "vault:set",
  vaultDelete: "vault:delete",
  embeddedGet: "embedded:get",
  embeddedOpen: "embedded:open",
  travelOpen: "travel:open",
  embeddedNavigate: "embedded:navigate",
  embeddedHistory: "embedded:history",
  embeddedActivate: "embedded:activate",
  embeddedClose: "embedded:close",
  embeddedBounds: "embedded:bounds",
  embeddedState: "embedded:state",
  engineGet: "engine:get",
  engineChanged: "engine:changed",
  engineSearch: "engine:search",
  engineInspect: "engine:inspect",
  engineDownload: "engine:download",
  engineCancel: "engine:cancel",
  engineRemove: "engine:remove",
  debugPortOpen: "app:debug-port-open",
  engineAddLocal: "engine:add-local",
  engineWarm: "engine:warm",
  engineSetContext: "engine:set-context",
  enginePopular: "engine:popular",
} as const;
