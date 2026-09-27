import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { AgentEvent } from "@vunemi/agent-core";
import type { OutboxEvent } from "@vunemi/mail";
import { CH, type ActivityEntry, type ArtefactView, type AutomationView, type EmbeddedState, type EngineView, type LockState, type VunemiApi, type QueuedMessage, type SessionList, type VoiceStatus } from "../shared/ipc.js";
import type { Locale } from "@vunemi/i18n";

const api: VunemiApi = {
  listProviders: () => ipcRenderer.invoke(CH.listProviders),
  getModelSettings: () => ipcRenderer.invoke(CH.modelSettingsGet),
  setModelSettings: (settings) => ipcRenderer.invoke(CH.modelSettingsSet, settings),
  checkModel: (spec) => ipcRenderer.invoke(CH.modelCheck, spec),
  startRun: (req) => ipcRenderer.invoke(CH.startRun, req),
  pickFiles: () => ipcRenderer.invoke(CH.pickFiles),
  // The renderer no longer sees a dropped file's path (File.path is gone);
  // only the preload can ask for it.
  pathForFile: (file) => webUtils.getPathForFile(file),
  steerRun: (req) => ipcRenderer.invoke(CH.steerRun, req),
  dropQueued: (id) => ipcRenderer.invoke(CH.dropQueued, id),
  interruptQueued: (id) => ipcRenderer.invoke(CH.interruptQueued, id),
  listQueued: () => ipcRenderer.invoke(CH.listQueued),
  onQueue: (listener) => {
    const handler = (_e: IpcRendererEvent, queue: QueuedMessage[]) => listener(queue);
    ipcRenderer.on(CH.queueChanged, handler);
    return () => ipcRenderer.removeListener(CH.queueChanged, handler);
  },
  stopRun: () => ipcRenderer.invoke(CH.stopRun),
  pauseRun: () => ipcRenderer.invoke(CH.pauseRun),
  resumeRun: () => ipcRenderer.invoke(CH.resumeRun),
  resolveApproval: (callId, decision) => ipcRenderer.invoke(CH.resolveApproval, callId, decision),
  resolveHandoff: (callId, outcome) => ipcRenderer.invoke(CH.resolveHandoff, callId, outcome),
  resolvePlan: (decision) => ipcRenderer.invoke(CH.resolvePlan, decision),
  resetSession: () => ipcRenderer.invoke(CH.resetSession),
  getContext: (model) => ipcRenderer.invoke(CH.contextGet, model),
  compactNow: (model, runId) => ipcRenderer.invoke(CH.contextCompact, model, runId),
  listSessions: () => ipcRenderer.invoke(CH.sessionsList),
  newSession: (projectId) => ipcRenderer.invoke(CH.sessionsNew, projectId),
  addProject: () => ipcRenderer.invoke(CH.projectsAdd),
  removeProject: (id) => ipcRenderer.invoke(CH.projectsRemove, id),
  revealProject: (id) => ipcRenderer.invoke(CH.projectsReveal, id),
  openSession: (id) => ipcRenderer.invoke(CH.sessionsOpen, id),
  resumeInterrupted: (model) => ipcRenderer.invoke(CH.sessionsResume, model),
  dismissInterrupted: () => ipcRenderer.invoke(CH.sessionsDismiss),
  deleteSession: (id) => ipcRenderer.invoke(CH.sessionsDelete, id),
  onSessions: (listener) => {
    const handler = (_e: IpcRendererEvent, list: SessionList) => listener(list);
    ipcRenderer.on(CH.sessionsChanged, handler);
    return () => ipcRenderer.removeListener(CH.sessionsChanged, handler);
  },
  listPreferences: () => ipcRenderer.invoke(CH.preferencesList),
  deletePreference: (id) => ipcRenderer.invoke(CH.preferencesDelete, id),
  forgetEverything: () => ipcRenderer.invoke(CH.forgetEverything),
  getLanguage: () => ipcRenderer.invoke(CH.languageGet),
  setLanguage: (locale) => ipcRenderer.invoke(CH.languageSet, locale),
  getLock: () => ipcRenderer.invoke(CH.lockGet),
  unlock: () => ipcRenderer.invoke(CH.lockUnlock),
  setAppLock: (on) => ipcRenderer.invoke(CH.lockSet, on),
  getTrustedSites: () => ipcRenderer.invoke(CH.trustedSitesGet),
  addTrustedSite: (raw) => ipcRenderer.invoke(CH.trustedSitesAdd, raw),
  removeTrustedSite: (host) => ipcRenderer.invoke(CH.trustedSitesRemove, host),
  onLock: (listener) => {
    const handler = (_e: unknown, state: LockState) => listener(state);
    ipcRenderer.on(CH.lockChanged, handler);
    return () => ipcRenderer.removeListener(CH.lockChanged, handler);
  },
  onLanguage: (listener) => {
    const handler = (_e: IpcRendererEvent, locale: Locale) => listener(locale);
    ipcRenderer.on(CH.languageChanged, handler);
    return () => ipcRenderer.removeListener(CH.languageChanged, handler);
  },
  getPolicy: () => ipcRenderer.invoke(CH.policyGet),
  setPolicy: (settings) => ipcRenderer.invoke(CH.policySet, settings),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AgentEvent) => listener(event);
    ipcRenderer.on(CH.event, handler);
    return () => ipcRenderer.removeListener(CH.event, handler);
  },
  listConnections: () => ipcRenderer.invoke(CH.connectionsList),
  connectionsOn: () => ipcRenderer.invoke(CH.connectionsOn),
  setConnection: (id, on) => ipcRenderer.invoke(CH.connectionsSet, id, on),
  setConnectionPart: (id, partId, on) => ipcRenderer.invoke(CH.connectionsSetPart, id, partId, on),
  connectConnection: (id) => ipcRenderer.invoke(CH.connectionsConnect, id),
  openPrivacySettings: (pane) => ipcRenderer.invoke(CH.connectionsPrivacy, pane),
  disconnectConnection: (id) => ipcRenderer.invoke(CH.connectionsDisconnect, id),
  addAccount: (id, provider, input) => ipcRenderer.invoke(CH.connectionsAddAccount, id, provider, input),
  removeAccount: (id, accountId) => ipcRenderer.invoke(CH.connectionsRemoveAccount, id, accountId),
  listOutbox: () => ipcRenderer.invoke(CH.outboxList),
  cancelOutbox: (id) => ipcRenderer.invoke(CH.outboxCancel, id),
  dismissOutbox: (id) => ipcRenderer.invoke(CH.outboxDismiss, id),
  onOutbox: (listener) => {
    const handler = (_e: IpcRendererEvent, event: OutboxEvent) => listener(event);
    ipcRenderer.on(CH.outboxChanged, handler);
    return () => ipcRenderer.removeListener(CH.outboxChanged, handler);
  },
  addMcpServer: (server) => ipcRenderer.invoke(CH.connectionsAddMcp, server),
  removeConnection: (id) => ipcRenderer.invoke(CH.connectionsRemove, id),
  listActivity: () => ipcRenderer.invoke(CH.activityList),
  undoActivity: (id) => ipcRenderer.invoke(CH.activityUndo, id),
  onActivity: (listener) => {
    const handler = (_e: IpcRendererEvent, entries: ActivityEntry[]) => listener(entries);
    ipcRenderer.on(CH.activityChanged, handler);
    return () => ipcRenderer.removeListener(CH.activityChanged, handler);
  },
  listArtefacts: () => ipcRenderer.invoke(CH.artefactsList),
  openArtefact: (id) => ipcRenderer.invoke(CH.artefactsOpen, id),
  revealArtefact: (id) => ipcRenderer.invoke(CH.artefactsReveal, id),
  showShortcut: (name) => ipcRenderer.invoke(CH.shortcutShow, name),
  undoArtefact: (id) => ipcRenderer.invoke(CH.artefactsUndo, id),
  listAutomations: () => ipcRenderer.invoke(CH.automationsList),
  setAutomationEnabled: (id, enabled) => ipcRenderer.invoke(CH.automationsSet, id, enabled),
  addSuggestedAutomation: (id) => ipcRenderer.invoke(CH.automationsSuggest, id),
  deleteAutomation: (id) => ipcRenderer.invoke(CH.automationsDelete, id),
  runAutomation: (id) => ipcRenderer.invoke(CH.automationsRun, id),
  onAutomations: (listener) => {
    const handler = (_e: IpcRendererEvent, rows: AutomationView[]) => listener(rows);
    ipcRenderer.on(CH.automationsChanged, handler);
    return () => ipcRenderer.removeListener(CH.automationsChanged, handler);
  },
  onArtefacts: (listener) => {
    const handler = (_e: IpcRendererEvent, rows: ArtefactView[]) => listener(rows);
    ipcRenderer.on(CH.artefactsChanged, handler);
    return () => ipcRenderer.removeListener(CH.artefactsChanged, handler);
  },
  readImage: (path) => ipcRenderer.invoke(CH.readImage, path),
  voiceStatus: () => ipcRenderer.invoke(CH.voiceStatus),
  voiceDownload: () => ipcRenderer.invoke(CH.voiceDownload),
  voiceDownloadCancel: () => ipcRenderer.invoke(CH.voiceDownloadCancel),
  onVoiceStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, status: VoiceStatus) => listener(status);
    ipcRenderer.on(CH.voiceChanged, handler);
    return () => ipcRenderer.removeListener(CH.voiceChanged, handler);
  },
  requestMic: () => ipcRenderer.invoke(CH.requestMic),
  transcribe: (wav) => ipcRenderer.invoke(CH.transcribe, wav),
  speak: (text) => ipcRenderer.invoke(CH.speak, text),
  stopSpeaking: () => ipcRenderer.invoke(CH.stopSpeaking),
  vaultStatus: () => ipcRenderer.invoke(CH.vaultStatus),
  vaultSet: (name, value, note) => ipcRenderer.invoke(CH.vaultSet, name, value, note),
  vaultDelete: (name) => ipcRenderer.invoke(CH.vaultDelete, name),
  getEmbedded: () => ipcRenderer.invoke(CH.embeddedGet),
  embeddedOpen: (url) => ipcRenderer.invoke(CH.embeddedOpen, url),
  embeddedNavigate: (id, url) => ipcRenderer.invoke(CH.embeddedNavigate, id, url),
  embeddedHistory: (id, action) => ipcRenderer.invoke(CH.embeddedHistory, id, action),
  embeddedActivate: (id) => ipcRenderer.invoke(CH.embeddedActivate, id),
  embeddedClose: (id) => ipcRenderer.invoke(CH.embeddedClose, id),
  embeddedBounds: (bounds) => ipcRenderer.send(CH.embeddedBounds, bounds),
  onEmbeddedState: (listener) => {
    const handler = (_e: IpcRendererEvent, state: EmbeddedState) => listener(state);
    ipcRenderer.on(CH.embeddedState, handler);
    return () => ipcRenderer.removeListener(CH.embeddedState, handler);
  },
  getEngine: () => ipcRenderer.invoke(CH.engineGet),
  onEngine: (listener) => {
    const handler = (_e: IpcRendererEvent, view: EngineView) => listener(view);
    ipcRenderer.on(CH.engineChanged, handler);
    return () => ipcRenderer.removeListener(CH.engineChanged, handler);
  },
  engineSearch: (text) => ipcRenderer.invoke(CH.engineSearch, text),
  enginePopular: () => ipcRenderer.invoke(CH.enginePopular),
  engineInspect: (repo) => ipcRenderer.invoke(CH.engineInspect, repo),
  engineDownload: (req) => ipcRenderer.invoke(CH.engineDownload, req),
  engineCancel: () => ipcRenderer.invoke(CH.engineCancel),
  engineRemove: (id) => ipcRenderer.invoke(CH.engineRemove, id),
  debugPortOpen: () => ipcRenderer.invoke(CH.debugPortOpen),
  engineAddLocal: () => ipcRenderer.invoke(CH.engineAddLocal),
  engineWarm: (spec) => ipcRenderer.invoke(CH.engineWarm, spec),
  engineSetContext: (id, context) => ipcRenderer.invoke(CH.engineSetContext, id, context),
};

contextBridge.exposeInMainWorld("vunemi", api);
