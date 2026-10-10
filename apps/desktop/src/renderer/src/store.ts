import { create } from "zustand";
import type { AgentEvent, ApprovalDecision, HandoffOutcome, PlanDecision } from "@vunemi/agent-core";
import type { ActivityEntry, AutomationLibraryView, ContextInfo, EmbeddedState, EngineView, MentionRef, VunemiApi, ProviderStatus, QueuedMessage, SessionList, VoiceStatus } from "../../shared/ipc.js";
import { earcon, HeldButton, record, type Recorder } from "./lib/audio.js";
import { foldEvent, replyText, type RunView } from "./lib/fold.js";
import { SentenceCutter, SpeechPlayer } from "./lib/speech.js";
import { getLocale, setLocale as setI18nLocale, t, type Locale } from "@vunemi/i18n";

declare global {
  interface Window {
    vunemi: VunemiApi;
  }
}

const MODEL_KEY = "vunemi.model";
const AUTO_OPEN_KEY = "vunemi.browserAutoOpen";
const VOICE_HOLD_KEY = "vunemi.voiceHold";
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

function readVoiceHold(): boolean {
  try {
    return localStorage.getItem(VOICE_HOLD_KEY) === "1";
  } catch {
    return false;
  }
}

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
export type View = "chat" | "artefacts" | "meetings" | "automations" | "settings" | "notes";

/** Settings keeps everything besides the conversation and what it made, so the sidebar stays short. */
export type SettingsSection = "permissions" | "security" | "connections" | "vault" | "outbox" | "automations" | "activity" | "model" | "language" | "appearance" | "memory" | "soul" | "data" | "updates";

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
  /** In voice chat, listen only while the microphone button is held, not by itself. */
  hold: boolean;
  /** This run was started by speaking, so it's the voice bar's business. */
  turn: boolean;
  error: string | null;
}

interface State {
  /** The interface language; main holds the setting. */
  locale: Locale;
  runs: RunView[];
  /** Visible as soon as Send is pressed, until the main process starts the run. */
  pendingStart: { goal: string; attachments: string[] } | null;
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
  /** The project whose notes the notes view shows. */
  notesProject: string | null;
  /** A connection to open and show when Connections next appears. */
  connectionFocus: string | null;
  /** The automation library, null until the main process says whether this build has it. */
  library: AutomationLibraryView | null;
  /** A recipe whose setup screen the Automations page opens with. */
  recipeFocus: string | null;
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
  send(goal: string, attachments?: string[], mentions?: MentionRef[]): Promise<void>;
  /** Stop the running task and hand it this message instead. */
  steer(goal: string, attachments?: string[], mentions?: MentionRef[]): Promise<void>;
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
  renameSession(id: string, title: string): Promise<void>;
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
  openProjectNotes(projectId: string): void;
  /** Settings › Connections, with this one opened. */
  openConnection(id: string | null): void;
  refreshLibrary(): Promise<void>;
  /** The Automations page, on this recipe's setup screen when one is named. */
  openAutomations(recipe?: string | null): void;
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
  stopTalking(): void;
  setVoiceHold(on: boolean): void;
  /** The microphone button went down, and came up, in voice chat that listens only while it is held. */
  holdStart(): void;
  holdEnd(): void;
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
/** What is said out loud in voice chat, and the reply it is being cut from as it is written. */
let player: SpeechPlayer | null = null;
let cutter: SentenceCutter | null = null;
let spokenRun: string | null = null;
/** The run the user spoke over or told to be quiet: no more of it is said. */
let silenced: string | null = null;
/** The turn was ended before the microphone had opened. */
let released = false;
/** The microphone is being asked for: a second press must not open a second one. */
let opening = false;
const button = new HeldButton();
/** Voice chat that listens by itself turns itself off when nobody speaks for this long. */
const QUIET_OFF_MS = 45_000;
let quiet: ReturnType<typeof setTimeout> | null = null;

/** How often the running transcript catches up with the speaker. */
const FOLLOW_MS = 1_500;

export const useStore = create<State>((set, get) => ({
  locale: getLocale(),
  runs: [],
  pendingStart: null,
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
  notesProject: null,
  connectionFocus: null,
  library: null,
  recipeFocus: null,
  navFolded: readFolded(),
  voice: { status: null, state: "off", partial: "", level: 0, handsFree: false, hold: readVoiceHold(), turn: false, error: null },
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

  async send(goal, attachments = [], mentions = []) {
    const { model } = get();
    if (!model || !goal.trim()) return;
    // Never refused for being busy: main decides whether this starts now or
    // waits, and says so by way of the queue.
    const pending = !get().running && !get().pendingStart ? { goal: goal.trim(), attachments } : null;
    set({ view: "chat", ...(pending && { pendingStart: pending }) });
    try {
      await window.vunemi.startRun({ goal: goal.trim(), model, ...(attachments.length > 0 && { attachments }), ...(mentions.length > 0 && { mentions }) });
    } catch (error) {
      if (pending && get().pendingStart === pending) set({ pendingStart: null });
      throw error;
    }
  },

  async steer(goal, attachments = [], mentions = []) {
    const { model } = get();
    if (!model || !goal.trim()) return;
    set({ view: "chat" });
    await window.vunemi.steerRun({ goal: goal.trim(), model, ...(attachments.length > 0 && { attachments }), ...(mentions.length > 0 && { mentions }) });
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
    if (get().pendingStart) set({ pendingStart: null });
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
    set({ sessions, runs: [], pendingStart: null, queue: [], viewer: null, view: "chat" });
    void get().refreshContext();
  },

  async addProject() {
    const sessions = await window.vunemi.addProject();
    if (!sessions) return;
    set({ sessions, runs: [], pendingStart: null, queue: [], viewer: null, view: "chat" });
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
    set({ sessions, runs: events.reduce(foldEvent, []), pendingStart: null, queue: [], view: "chat" });
    void get().refreshContext();
  },

  async renameSession(id, title) {
    set({ sessions: await window.vunemi.renameSession(id, title) });
  },

  async deleteSession(id) {
    const wasCurrent = id === get().sessions.current;
    const sessions = await window.vunemi.deleteSession(id);
    set({ sessions, ...(wasCurrent && { runs: [], pendingStart: null, queue: [], viewer: null }) });
  },

  async forgetSession() {
    const sessions = await window.vunemi.resetSession();
    set({ sessions, runs: [], pendingStart: null, queue: [], viewer: null });
    void get().refreshContext();
  },

  setSessions(sessions) {
    // Main moved to another conversation on its own (a scheduled task started): its timeline starts empty.
    if (sessions.current !== get().sessions.current) set({ sessions, runs: [], pendingStart: null, queue: [], viewer: null });
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
    if (voice.state !== "off" || opening) return;
    opening = true;
    // macOS puts up its own dialog the first time; do it before the earcon,
    // so the sound doesn't promise a microphone the user hasn't allowed yet.
    const allowed = await window.vunemi.requestMic().finally(() => (opening = false));
    if (!allowed) {
      released = false;
      set((s) => ({
        voice: { ...s.voice, error: t("mic.notGranted") },
      }));
      return;
    }
    set((s) => ({ voice: { ...s.voice, state: "listening", partial: "", level: 0, error: null } }));
    earcon("start");
    // Voice chat listening by itself: the microphone is open for as long as the chat is.
    const itself = get().voice.handsFree && !get().voice.hold;
    try {
      recorder = await record({
        near: itself,
        onLevel: (level) => set((s) => (s.voice.state === "listening" ? { voice: { ...s.voice, level } } : s)),
        // Hands-free: silence ends the turn, and the task starts straight away.
        onSilence: () => {
          if (get().voice.handsFree && !get().voice.hold) void get().finishListening(true);
        },
      });
      followAlong(set);
      if (itself) offWhenQuiet(set, get);
      if (released) {
        released = false;
        void get().finishListening(true);
      }
    } catch (err) {
      recorder = null;
      released = false;
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
    stayOn();
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
    released = false;
    stopFollowing();
    stayOn();
    // A transcription still in flight is abandoned rather than awaited: its
    // result is ignored because the turn it belonged to is over.
    turn += 1;
    silence();
    set((s) => ({ voice: { ...s.voice, state: "off", partial: "", level: 0 } }));
  },

  /** "Stop talking": Vunemi is quiet and the turn is the user's. */
  stopTalking() {
    if (get().voice.state !== "speaking") return;
    silence();
    yourTurn(set, get);
  },

  setHandsFree(on) {
    set((s) => ({ voice: { ...s.voice, handsFree: on } }));
    // Off while it talks or listens: quiet, and the microphone is let go.
    if (!on && get().voice.state !== "off") get().cancelListening();
    else if (!on) silence();
    // Turning voice chat on starts the conversation; a mode that waits for
    // a second button looks like a button that doesn't work. Unless the
    // user chose to hold the button: then nothing listens until they do.
    else if (!get().voice.hold && get().voice.status?.canHear && get().voice.state === "off") void get().listen();
  },

  setVoiceHold(on) {
    try {
      localStorage.setItem(VOICE_HOLD_KEY, on ? "1" : "0");
    } catch {
      // Kept for this window only.
    }
    set((s) => ({ voice: { ...s.voice, hold: on } }));
    if (!get().voice.handsFree) return;
    // The microphone follows the choice at once: closed until held, or open again.
    if (on && get().voice.state === "listening") get().cancelListening();
    else if (!on && get().voice.state === "off" && !get().running) void get().listen();
  },

  holdStart() {
    const press = button.down(get().voice.state === "listening", Date.now());
    if (press === "end") return void endHeld(get);
    // Holding the button while Vunemi talks is how it is told to stop and listen.
    if (get().voice.state !== "off") get().cancelListening();
    void get().listen();
  },

  holdEnd() {
    if (button.up(Date.now()) === "end") endHeld(get);
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
    // Hands-free means Vunemi answers out loud, sentence by sentence as it writes, then listens again.
    if (event.type === "message.delta" && get().voice.handsFree) {
      if (spokenRun !== event.runId) {
        spokenRun = event.runId;
        cutter = new SentenceCutter();
      }
      if (cutter) sayMore(event.runId, cutter.push(event.text), set, get);
    }
    if (event.type === "run.finished" && get().voice.handsFree) {
      const said = replyText(get().runs.find((r) => r.runId === event.runId));
      void finishTalking(event.runId, said || event.detail, set, get);
    }
    set((s) => ({
      runs: foldEvent(s.runs, event),
      pendingStart: event.type === "run.started" && s.pendingStart?.goal === event.goal ? null : s.pendingStart,
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

  openProjectNotes(projectId) {
    set({ view: "notes", notesProject: projectId });
  },

  openConnection(id) {
    set(id === null ? { connectionFocus: null } : { view: "settings", settingsSection: "connections", connectionFocus: id });
  },

  async refreshLibrary() {
    // A build without the library answers "off"; an older main process doesn't answer at all.
    const library = await window.vunemi.automationLibrary().catch(() => null);
    set({ library });
  },

  openAutomations(recipe = null) {
    set({ view: "automations", recipeFocus: recipe });
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

/** Quiet, now: what is being said stops, what was waiting is not said, and the rest of that reply stays unsaid. */
function silence(): void {
  silenced = spokenRun;
  player?.stop();
  void window.vunemi.stopSpeaking();
}

/** Says more of a reply. The first sentence opens the microphone too, so the user can speak over it. */
function sayMore(runId: string, sentences: string[], set: Set, get: () => State): void {
  if (sentences.length === 0 || runId === silenced) return;
  const state = get().voice.state;
  // The user has the turn: nothing is said over them, now or when they are done.
  if (state === "listening" || state === "thinking") {
    silenced = runId;
    return;
  }
  player ??= new SpeechPlayer({ synthesize: (text) => window.vunemi.synthesize(text) });
  for (const sentence of sentences) player.say(sentence);
  if (state !== "speaking") void startTalking(set, get);
}

async function startTalking(set: Set, get: () => State): Promise<void> {
  set((s) => ({ voice: { ...s.voice, state: "speaking", partial: "", level: 0, error: null } }));
  // No microphone opens by itself where the user holds a button to talk.
  if (recorder || get().voice.hold) return;
  try {
    const opened = await record({
      near: true,
      onLevel: (level) => set((s) => (s.voice.state === "listening" ? { voice: { ...s.voice, level } } : s)),
      onSilence: () => {
        if (get().voice.handsFree && !get().voice.hold) void get().finishListening(true);
      },
      onSpokenOver: () => {
        if (get().voice.state !== "speaking") return;
        silence();
        // No sound for it: they are already talking.
        set((s) => ({ voice: { ...s.voice, state: "listening", partial: "", level: 0, error: null } }));
        followAlong(set);
      },
    });
    // The talking may have ended, or been stopped, while the microphone was opening.
    if (get().voice.state !== "speaking" || recorder) opened.cancel();
    else recorder = opened;
  } catch {
    // No microphone: Vunemi still talks, it just can't be spoken over.
  }
}

/** The reply is over: its last words are said, then the turn goes back — the hands-free loop. */
async function finishTalking(runId: string, whole: string, set: Set, get: () => State): Promise<void> {
  if (spokenRun === runId && cutter) sayMore(runId, cutter.flush(), set, get);
  else if (runId !== silenced && whole.trim()) {
    // None of it was said while it was written (it came whole, or it is an error's text): it is said now.
    spokenRun = runId;
    const all = new SentenceCutter();
    sayMore(runId, [...all.push(whole), ...all.flush()], set, get);
  }
  cutter = null;
  await player?.finished();
  // Spoken over or stopped in the meantime: the turn has already gone where it went.
  if (get().voice.state === "speaking") yourTurn(set, get);
}

/** From talking to listening, on the microphone that is already open. */
function yourTurn(set: Set, get: () => State): void {
  const open = recorder;
  // Only if the user hasn't since turned it off or started something else.
  if (!get().voice.handsFree || get().running || !open) {
    open?.cancel();
    recorder = null;
    set((s) => ({ voice: { ...s.voice, state: "off", level: 0 } }));
    if (get().voice.handsFree && !get().voice.hold && !get().running) void get().listen();
    return;
  }
  open.engage();
  set((s) => ({ voice: { ...s.voice, state: "listening", partial: "", level: 0, error: null } }));
  earcon("start");
  followAlong(set);
  offWhenQuiet(set, get);
}

/**
 * Voice chat that listens by itself does not stay open on an empty room:
 * when nobody has spoken for a while it turns itself off, and says so.
 */
function offWhenQuiet(set: Set, get: () => State): void {
  stayOn();
  quiet = setTimeout(() => {
    quiet = null;
    if (get().voice.state !== "listening" || !get().voice.handsFree || recorder?.spoke()) return;
    get().setHandsFree(false);
    earcon("stop");
    set((s) => ({ voice: { ...s.voice, error: t("voice.wentQuiet") } }));
  }, QUIET_OFF_MS);
}

function stayOn(): void {
  if (quiet) clearTimeout(quiet);
  quiet = null;
}

/** The held turn is over: sent now, or as soon as the microphone that is still opening has opened. */
function endHeld(get: () => State): void {
  if (recorder) void get().finishListening(true);
  else if (opening || get().voice.state === "listening") released = true;
}
