import { create } from "zustand";
import type { AgentEvent, ApprovalDecision, HandoffOutcome, PlanDecision } from "@vunemi/agent-core";
import type { ActivityEntry, ContextInfo, EmbeddedState, EngineView, VunemiApi, ProviderStatus, QueuedMessage, SessionList, VoiceStatus } from "../../shared/ipc.js";
import { earcon, record, type Recorder } from "./lib/audio.js";
import { foldEvent, replyText, type RunView } from "./lib/fold.js";
import { getLocale, setLocale as setI18nLocale, t, type Locale } from "@vunemi/i18n";

declare global {
  interface Window {
    vunemi: VunemiApi;
  }
}

const MODEL_KEY = "vunemi.model";
const AUTO_OPEN_KEY = "vunemi.browserAutoOpen";
const FOLDED_KEY = "vunemi.navFolded";

/** Whether the sidebar is folded to a strip of icons; remembered per Mac. */
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeFolded(on: boolean): void {
  try {
    localStorage.setItem(FOLDED_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

/** Whether the browser panel opens by itself when a page opens. Off unless chosen: Vunemi browses in the background. */
function readAutoOpen(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function storeAutoOpen(on: boolean): void {
  try {
    localStorage.setItem(AUTO_OPEN_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

/** Moves what an earlier build saved under the app's earlier name, once. */
function carryOverStorage(): void {
  try {
    for (const key of [MODEL_KEY, AUTO_OPEN_KEY, FOLDED_KEY]) {
      const old = `ocak.${key.slice("vunemi.".length)}`;
      const value = localStorage.getItem(old);
      if (value === null) continue;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      localStorage.removeItem(old);
    }
  } catch {
    // Storage unavailable; nothing to carry over.
  }
}
carryOverStorage();

function readStoredModel(): string | null {
  try {
    const spec = localStorage.getItem(MODEL_KEY);
    // The built-in engine's models were saved as "tenami:<id>" before the rename.
    return spec?.startsWith("tenami:") ? `vunemi:${spec.slice("tenami:".length)}` : spec;
  } catch {
    return null;
  }
}

function storeModel(spec: string | null): void {
  try {
    if (spec) localStorage.setItem(MODEL_KEY, spec);
    else localStorage.removeItem(MODEL_KEY);
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

/**
 * Whose turn it is, out loud. Every one of these is shown as itself — the
 * user should never have to guess whether Vunemi is still listening.
 */
/** Which view fills the main column. */
export type View = "chat" | "artefacts" | "meetings" | "settings";

/** Settings keeps everything besides the conversation and what it made, so the sidebar stays short. */
export type SettingsSection = "permissions" | "security" | "connections" | "vault" | "outbox" | "automations" | "activity" | "model" | "language" | "appearance" | "memory" | "data";

export type VoiceState = "off" | "listening" | "thinking" | "speaking";

interface Voice {
  status: VoiceStatus | null;
  state: VoiceState;
  /** What Vunemi has heard so far this turn, while the user is still talking. */
  partial: string;
  /** 0–1 microphone level, for the waveform. */
  level: number;
  /** Hands-free: Vunemi listens again after it finishes speaking. */
  handsFree: boolean;
  /** This run was started by speaking, so it's the voice bar's business. */
  turn: boolean;
  error: string | null;
}

interface State {
  /** The interface language; main holds the setting. */
  locale: Locale;
  runs: RunView[];
  /** Kept conversations, and which one new tasks go into. */
  sessions: SessionList;
  /** Messages sent while the agent was busy, waiting their turn. */
  queue: QueuedMessage[];
  providers: ProviderStatus[] | null;
  model: string | null;
  /** Vunemi's own engine: what it offers, what is downloaded, what runs. */
  engine: EngineView | null;
  running: boolean;
  /** The user paused the run; it holds at its next safe point. */
  paused: boolean;
  embedded: EmbeddedState;
  paneOpen: boolean;
  /** A picture opened from a call card, shown large beside the chat. */
  viewer: { path: string; label?: string } | null;
  browserAutoOpen: boolean;
  activity: ActivityEntry[];
  /** Which view fills the main column. */
  view: View;
  /** The Settings section on screen, kept so another view can open Settings at the right place. */
  settingsSection: SettingsSection;
  /** A connection to open and show when Connections next appears. */
  connectionFocus: string | null;
  /** The sidebar folded to icons. */
  navFolded: boolean;
  voice: Voice;
  /** Text just dictated, waiting for the composer to pick it up. */
  dictated: string | null;
  /** A suggestion picked on the home screen: it replaces what the box holds, so picking it twice doesn't repeat it. */
  suggested: string | null;
  /** The chosen model's window and how full the conversation keeps it; null until main says. */
  context: ContextInfo | null;

  refreshProviders(): Promise<void>;
  setModel(spec: string): void;
  refreshContext(): Promise<void>;
  /** Condenses the earlier part of the conversation now. */
  compactNow(): Promise<void>;
  send(goal: string, attachments?: string[]): Promise<void>;
  /** Stop the running task and hand it this message instead. */
  steer(goal: string, attachments?: string[]): Promise<void>;
  dropQueued(id: string): Promise<void>;
  /** A waiting message that can't wait: stops the current task and does this now. */
  interruptQueued(id: string): Promise<void>;
  setQueue(queue: QueuedMessage[]): void;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  decide(callId: string, decision: ApprovalDecision): Promise<void>;
  resolveHandoff(callId: string, outcome: HandoffOutcome): Promise<void>;
  resolvePlan(decision: PlanDecision): Promise<void>;
  /** A fresh conversation; the current one stays in the list. */
  newSession(projectId?: string): Promise<void>;
  /** The user picks a folder in macOS's dialog; a conversation in it starts. */
  addProject(): Promise<void>;
  removeProject(id: string): Promise<void>;
  revealProject(id: string): Promise<void>;
  openSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Forgets the conversation on screen. */
  forgetSession(): Promise<void>;
  setSessions(list: SessionList): void;
  /** Switches the language everywhere: this window, main's messages, the agent's replies. */
  setLocale(locale: Locale): Promise<void>;
  /** Main says the language changed. */
  applyLocale(locale: Locale): void;
  ingest(event: AgentEvent): void;
  setEmbedded(state: EmbeddedState): void;
  setPaneOpen(open: boolean): void;
  showPicture(picture: { path: string; label?: string } | null): void;
  /** A page Vunemi made, shown offline beside the chat; null when closed. */
  preview: { title: string } | null;
  showPreview(id: string): Promise<void>;
  closePreview(): void;
  setBrowserAutoOpen(on: boolean): void;
  setActivity(entries: ActivityEntry[]): void;
  setView(view: View): void;
  openSettings(section: SettingsSection): void;
  /** Settings › Connections, with this one opened. */
  openConnection(id: string | null): void;
  setNavFolded(folded: boolean): void;
  setEngine(view: EngineView): void;
  refreshEngine(): Promise<void>;

  refreshVoice(): Promise<void>;
  setVoiceStatus(status: VoiceStatus): void;
  /** The user pressed "download" for the speech model. */
  downloadVoice(): Promise<void>;
  cancelVoiceDownload(): Promise<void>;
  /** Push to talk. In hands-free mode the turn also ends on its own. */
  listen(): Promise<void>;
  /** Ends the turn and transcribes; `send` decides whether to run it too. */
  finishListening(send: boolean): Promise<void>;
  cancelListening(): void;
  setHandsFree(on: boolean): void;
  takeDictation(): string | null;
  /** Puts a suggested task in the composer for the user to edit; it isn't sent. */
  suggest(text: string): void;
}

/** The open microphone, if there is one. Not state: nothing renders it. */
let recorder: Recorder | null = null;
let following: ReturnType<typeof setInterval> | null = null;
/** Bumped whenever a turn is abandoned, so late answers can be recognised. */
let turn = 0;

/** How often the running transcript catches up with the speaker. */
const FOLLOW_MS = 1_500;

export const useStore = create<State>((set, get) => ({
  locale: getLocale(),
  runs: [],
  sessions: { current: "", sessions: [], projects: [] },
  queue: [],
  providers: null,
  engine: null,
  model: readStoredModel(),
  running: false,
  paused: false,
  embedded: { tabs: [], activeId: null },
  paneOpen: false,
  viewer: null,
  preview: null,
  browserAutoOpen: readAutoOpen(),
  activity: [],
  view: "chat",
  settingsSection: "permissions",
  connectionFocus: null,
  navFolded: readFolded(),
  voice: { status: null, state: "off", partial: "", level: 0, handsFree: false, turn: false, error: null },
  dictated: null,
  suggested: null,
  context: null,

  async refreshProviders() {
    const providers = await window.vunemi.listProviders();
    const all = providers.flatMap((p) => p.models);
    const current = get().model;
    // Keep the user's choice if it's still served; otherwise fall back.
    const model = current && all.includes(current) ? current : (all[0] ?? null);
    storeModel(model);
    set({ providers, model });
    // A built-in model loads in the background, so the first message waits less.
    if (model?.startsWith("vunemi:")) void window.vunemi.engineWarm(model);
    void get().refreshContext();
  },

  setModel(spec) {
    storeModel(spec);
    set({ model: spec });
    if (spec?.startsWith("vunemi:")) void window.vunemi.engineWarm(spec);
    void get().refreshContext();
  },

  setEngine(view) {
    const before = get().engine;
    set({ engine: view });
    // The built-in engine tells its window only once loaded (a new context
    // length reloads it too): ask again when the chosen model becomes ready.
    const model = get().model;
    const id = model?.startsWith("vunemi:") ? model.slice("vunemi:".length) : null;
    const ready = (v: EngineView | null) => v?.engine.state === "ready" && v.engine.model === id;
    if (id && ready(view) && !ready(before)) void get().refreshContext();
  },

  async refreshEngine() {
    set({ engine: await window.vunemi.getEngine() });
  },

  async refreshContext() {
    const model = get().model;
    if (!model) return;
    try {
      const context = await window.vunemi.getContext(model);
      set({ context });
    } catch {
      // Locked, or no model yet: the meter keeps its last reading.
    }
  },

  async compactNow() {
    const { model, runs, running } = get();
    const last = runs.at(-1);
    if (!model || !last || running) return;
    await window.vunemi.compactNow(model, last.runId);
    await get().refreshContext();
  },

  async send(goal, attachments = []) {
    const { model } = get();
    if (!model || !goal.trim()) return;
    // Never refused for being busy: main decides whether this starts now or
    // waits, and says so by way of the queue.
    set({ view: "chat" });
    await window.vunemi.startRun({ goal: goal.trim(), model, ...(attachments.length > 0 && { attachments }) });
  },

  async steer(goal, attachments = []) {
    const { model } = get();
    if (!model || !goal.trim()) return;
    set({ view: "chat" });
    await window.vunemi.steerRun({ goal: goal.trim(), model, ...(attachments.length > 0 && { attachments }) });
  },

  async dropQueued(id) {
    await window.vunemi.dropQueued(id);
  },

  async interruptQueued(id) {
    await window.vunemi.interruptQueued(id);
  },

  setQueue(queue) {
    set({ queue });
  },

  async stop() {
    await window.vunemi.stopRun();
  },

  async pause() {
    await window.vunemi.pauseRun();
  },

  async resume() {
    await window.vunemi.resumeRun();
  },

  async decide(callId, decision) {
    await window.vunemi.resolveApproval(callId, decision);
  },

  async resolveHandoff(callId, outcome) {
    await window.vunemi.resolveHandoff(callId, outcome);
  },

  async resolvePlan(decision) {
    await window.vunemi.resolvePlan(decision);
  },

  async newSession(projectId) {
    const sessions = await window.vunemi.newSession(projectId);
    set({ sessions, runs: [], queue: [], viewer: null, view: "chat" });
    void get().refreshContext();
  },

  async addProject() {
    const sessions = await window.vunemi.addProject();
    if (!sessions) return;
    set({ sessions, runs: [], queue: [], viewer: null, view: "chat" });
    void get().refreshContext();
  },

  async removeProject(id) {
    set({ sessions: await window.vunemi.removeProject(id) });
  },

  async revealProject(id) {
    await window.vunemi.revealProject(id);
  },

  async openSession(id) {
    if (id === get().sessions.current) return set({ view: "chat" });
    const { events, ...sessions } = await window.vunemi.openSession(id);
    // The timeline is a fold of its events, so a kept one rebuilds exactly.
    set({ sessions, runs: events.reduce(foldEvent, []), queue: [], view: "chat" });
    void get().refreshContext();
  },

  async deleteSession(id) {
    const wasCurrent = id === get().sessions.current;
    const sessions = await window.vunemi.deleteSession(id);
    set({ sessions, ...(wasCurrent && { runs: [], queue: [], viewer: null }) });
  },

  async forgetSession() {
    const sessions = await window.vunemi.resetSession();
    set({ sessions, runs: [], queue: [], viewer: null });
    void get().refreshContext();
  },

  setSessions(sessions) {
    // Main moved to another conversation on its own (a scheduled task started): its timeline starts empty.
    if (sessions.current !== get().sessions.current) set({ sessions, runs: [], queue: [], viewer: null });
    else set({ sessions });
  },

  async setLocale(locale) {
    get().applyLocale(await window.vunemi.setLanguage(locale));
  },

  applyLocale(locale) {
    setI18nLocale(locale);
    document.documentElement.lang = locale;
    set({ locale });
  },

  async refreshVoice() {
    const status = await window.vunemi.voiceStatus();
    set((s) => ({ voice: { ...s.voice, status } }));
  },

  setVoiceStatus(status) {
    set((s) => ({ voice: { ...s.voice, status } }));
  },

  async downloadVoice() {
    set((s) => ({ voice: { ...s.voice, error: null } }));
    try {
      const status = await window.vunemi.voiceDownload();
      set((s) => ({ voice: { ...s.voice, status } }));
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
      set((s) => ({ voice: { ...s.voice, error: message } }));
      void get().refreshVoice();
    }
  },

  async cancelVoiceDownload() {
    await window.vunemi.voiceDownloadCancel();
  },

  async listen() {
    const { voice } = get();
    if (voice.state !== "off") return;
    // macOS puts up its own dialog the first time; do it before the earcon,
    // so the sound doesn't promise a microphone the user hasn't allowed yet.
    if (!(await window.vunemi.requestMic())) {
      set((s) => ({
        voice: { ...s.voice, error: t("mic.notGranted") },
      }));
      return;
    }
    set((s) => ({ voice: { ...s.voice, state: "listening", partial: "", level: 0, error: null } }));
    earcon("start");
    try {
      recorder = await record({
        onLevel: (level) => set((s) => (s.voice.state === "listening" ? { voice: { ...s.voice, level } } : s)),
        // Hands-free: silence ends the turn, and the task starts straight away.
        onSilence: () => {
          if (get().voice.handsFree) void get().finishListening(true);
        },
      });
      followAlong(set);
    } catch (err) {
      recorder = null;
      earcon("error");
      // Say which failure it was: a refused microphone and a broken audio
      // graph look identical to the user otherwise.
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const denied = /NotAllowed|Permission/i.test(why);
      set((s) => ({
        voice: {
          ...s.voice,
          state: "off",
          level: 0,
          error: denied
            ? t("mic.denied")
            : t("mic.failed", { why }),
        },
      }));
    }
  },

  async finishListening(send) {
    const current = recorder;
    if (!current || get().voice.state !== "listening") return;
    recorder = null;
    stopFollowing();
    earcon("stop");
    const mine = turn;
    set((s) => ({ voice: { ...s.voice, state: "thinking", level: 0 } }));
    try {
      const wav = await current.stop();
      const text = wav ? (await window.vunemi.transcribe(wav)).trim() : "";
      if (mine !== turn) return; // the user gave up while we were transcribing
      set((s) => ({
        voice: { ...s.voice, state: "off", partial: "", error: text ? null : t("mic.nothingHeard") },
        // Voice chat is a conversation: what was said goes straight out,
        // not into the text box as well.
        ...(text && !send && { dictated: text }),
      }));
      if (text && send) {
        set((s) => ({ voice: { ...s.voice, turn: true } }));
        await get().send(text);
      }
      else if (!text) earcon("error");
    } catch (err) {
      if (mine !== turn) return;
      earcon("error");
      set((s) => ({
        voice: { ...s.voice, state: "off", partial: "", error: String((err as Error).message ?? err).replace(/^.*Error: /, "") },
      }));
    }
  },

  /** The way out of any voice state: drop the microphone, stop waiting, be quiet. */
  cancelListening() {
    recorder?.cancel();
    recorder = null;
    stopFollowing();
    // A transcription still in flight is abandoned rather than awaited: its
    // result is ignored because the turn it belonged to is over.
    turn += 1;
    void window.vunemi.stopSpeaking();
    set((s) => ({ voice: { ...s.voice, state: "off", partial: "", level: 0 } }));
  },

  setHandsFree(on) {
    set((s) => ({ voice: { ...s.voice, handsFree: on } }));
    if (!on) void window.vunemi.stopSpeaking();
    // Turning voice chat on starts the conversation; a mode that waits for
    // a second button looks like a button that doesn't work.
    else if (get().voice.status?.canHear && get().voice.state === "off") void get().listen();
  },

  suggest(text) {
    set({ suggested: text });
  },

  /** The composer takes the transcript exactly once. */
  takeDictation() {
    const text = get().dictated;
    if (text !== null) set({ dictated: null });
    return text;
  },

  ingest(event) {
    // A typed task speaks for itself in the timeline; the voice bar is only
    // for turns that started with the microphone.
    if (event.type === "run.finished") set((s) => ({ voice: { ...s.voice, turn: false } }));
    // Hands-free means Vunemi answers out loud, then listens again.
    if (event.type === "run.finished" && get().voice.handsFree) {
      const said = replyText(get().runs.find((r) => r.runId === event.runId));
      void speakThenListen(said || event.detail, set, get);
    }
    set((s) => ({
      runs: foldEvent(s.runs, event),
      // Follows the events rather than the send() call: a queued message
      // starts on its own, with nobody in the UI having asked for it.
      running: event.type === "run.started" ? true : event.type === "run.finished" ? false : s.running,
      paused:
        event.type === "run.paused" ? true : event.type === "run.resumed" || event.type === "run.finished" ? false : s.paused,
      // The user will need to see the page the agent is handing over.
      ...(event.type === "handoff.required" && { paneOpen: true }),
    }));
    if (event.type === "run.finished" || event.type === "context.compacted") void get().refreshContext();
  },

  setEmbedded(state) {
    // A tab that just opened (by the agent or a link) brings the pane up, if
    // the user wants that; otherwise the agent browses in the background.
    const opened = state.tabs.some((t) => !get().embedded.tabs.some((o) => o.id === t.id));
    set({ embedded: state, ...(opened && get().browserAutoOpen && { paneOpen: true }) });
  },

  setBrowserAutoOpen(on) {
    storeAutoOpen(on);
    set({ browserAutoOpen: on });
  },

  setPaneOpen(open) {
    set({ paneOpen: open });
  },

  showPicture(picture) {
    set({ viewer: picture });
  },

  async showPreview(id) {
    const title = await window.vunemi.previewArtefact(id);
    // It opens where the browser and pictures do: beside the chat.
    set({ preview: { title }, viewer: null, view: "chat" });
  },

  closePreview() {
    window.vunemi.previewClose();
    set({ preview: null });
  },

  setActivity(entries) {
    set({ activity: entries });
  },

  setView(view) {
    set({ view });
  },

  openSettings(section) {
    set({ view: "settings", settingsSection: section });
  },

  openConnection(id) {
    set(id === null ? { connectionFocus: null } : { view: "settings", settingsSection: "connections", connectionFocus: id });
  },

  setNavFolded(folded) {
    storeFolded(folded);
    set({ navFolded: folded });
  },
}));

type Set = (fn: (s: State) => Partial<State> | State) => void;

/**
 * The running transcript. Whisper re-reads the whole clip each time, which is
 * cheap enough at this length and means the text settles as the sentence
 * finishes instead of drifting. One request at a time; a slow pass just skips
 * a beat.
 */
function followAlong(set: Set): void {
  stopFollowing();
  let busy = false;
  following = setInterval(() => {
    const clip = !busy ? recorder?.snapshot() : null;
    if (!clip) return;
    busy = true;
    void window.vunemi
      .transcribe(clip)
      .then((text) => {
        if (text.trim() && recorder) set((s) => (s.voice.state === "listening" ? { voice: { ...s.voice, partial: text.trim() } } : s));
      })
      .catch(() => {
        // The final transcription is the one that matters; this one can fail.
      })
      .finally(() => {
        busy = false;
      });
  }, FOLLOW_MS);
}

function stopFollowing(): void {
  if (following) clearInterval(following);
  following = null;
}

/** Says the answer, then hands the turn back — the hands-free loop. */
async function speakThenListen(text: string, set: Set, get: () => State): Promise<void> {
  const said = text.trim();
  if (!said) return;
  set((s) => ({ voice: { ...s.voice, state: "speaking" } }));
  try {
    await window.vunemi.speak(said);
  } finally {
    set((s) => (s.voice.state === "speaking" ? { voice: { ...s.voice, state: "off" } } : s));
  }
  // Only if the user hasn't since turned it off or started typing.
  if (get().voice.handsFree && get().voice.state === "off" && !get().running) await get().listen();
}
