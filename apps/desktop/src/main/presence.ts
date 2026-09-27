/**
 * Vunemi while you're looking elsewhere: a run keeps going with the window
 * closed, so approvals can't be modal dialogs. Instead the menu bar shows
 * what's happening and how many decisions are waiting, the Dock carries the
 * same count, and a notification brings you back to the right card.
 *
 * Nothing here decides anything: it reports the run and opens the window.
 */

import { app, Menu, Notification, Tray, type BrowserWindow, type NativeImage } from "electron";
import { nativeImage } from "electron";
import { join } from "node:path";
import type { AgentEvent } from "@vunemi/agent-core";
import { onLocaleChange, t } from "@vunemi/i18n";

export interface RunControls {
  show(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  emergencyStop(): void;
  /** While Vunemi is locked, a notification says that something happened, not what. */
  locked?(): boolean;
}

export interface PresenceState {
  running: boolean;
  paused: boolean;
  /** Approval cards and handoffs the user hasn't answered. */
  waiting: number;
  goal: string;
}

export class Presence {
  private tray: Tray | null = null;
  private state: PresenceState = { running: false, paused: false, waiting: 0, goal: "" };
  private readonly pending = new Set<string>();

  constructor(
    private readonly controls: RunControls,
    private readonly window: () => BrowserWindow | null,
    private readonly iconDir: string,
  ) {}

  start(): void {
    if (this.tray) return;
    this.tray = new Tray(this.icon());
    this.tray.setToolTip("Vunemi");
    this.render();
    // The menu is built from words; rebuild it when they change.
    onLocaleChange(() => this.render());
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /** Watches the same event stream as the UI. */
  record(event: AgentEvent): void {
    switch (event.type) {
      case "run.started":
        this.pending.clear();
        this.set({ running: true, paused: false, waiting: 0, goal: event.goal });
        return;
      case "run.paused":
        this.set({ ...this.state, paused: true });
        return;
      case "run.resumed":
        this.set({ ...this.state, paused: false });
        return;
      case "approval.required":
        this.pending.add(event.callId);
        this.set({ ...this.state, waiting: this.pending.size });
        this.notify(t("presence.approval"), event.preview ?? event.tool, this.state.goal);
        return;
      case "handoff.required":
        this.pending.add(event.callId);
        this.set({ ...this.state, waiting: this.pending.size });
        this.notify(t("call.yourTurn"), event.reason, this.state.goal);
        return;
      case "plan.proposed":
        this.pending.add(`plan:${event.runId}`);
        this.set({ ...this.state, waiting: this.pending.size });
        this.notify(t("plan.approveTitle"), event.steps.join(" · "), this.state.goal);
        return;
      case "plan.resolved":
        this.pending.delete(`plan:${event.runId}`);
        this.set({ ...this.state, waiting: this.pending.size });
        return;
      case "approval.resolved":
      case "handoff.resolved":
        this.pending.delete(event.callId);
        this.set({ ...this.state, waiting: this.pending.size });
        return;
      case "run.finished": {
        this.pending.clear();
        const goal = this.state.goal;
        this.set({ running: false, paused: false, waiting: 0, goal: "" });
        if (event.status === "done") this.notify(t("presence.done"), firstLine(event.detail), goal);
        else if (event.status !== "stopped") this.notify(t("presence.unfinished"), firstLine(event.detail), goal);
        return;
      }
    }
  }

  /** Draws the menu bar again, for when the lock changes what it may show. */
  refresh(): void {
    this.render();
  }

  // -- internals -------------------------------------------------------------

  private set(next: PresenceState): void {
    this.state = next;
    this.render();
  }

  /** Only when the user isn't already looking at it. */
  private notify(title: string, body: string, subtitle: string): void {
    if (this.window()?.isFocused()) return;
    if (!Notification.isSupported()) return;
    // A locked Vunemi shouldn't read the plan or the answer out on the screen.
    const hidden = this.controls.locked?.() === true;
    const n = new Notification({ title, body: hidden ? t("lock.notification") : body.slice(0, 220), subtitle: hidden ? "" : subtitle.slice(0, 120), silent: false });
    n.on("click", () => this.controls.show());
    n.show();
  }

  private render(): void {
    const { running, paused, waiting } = this.state;
    const status = !running ? t("presence.idle") : paused ? t("presence.paused") : t("runStatus.running");

    if (app.dock) app.dock.setBadge(waiting > 0 ? String(waiting) : "");

    const tray = this.tray;
    if (!tray) return;
    tray.setTitle(waiting > 0 ? ` ${waiting}` : "");
    // Locked, the menu bar says what Vunemi is doing, never what about.
    const goal = this.controls.locked?.() === true ? "" : this.state.goal;
    tray.setToolTip(goal ? `Vunemi · ${status} · ${goal}` : `Vunemi · ${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: goal ? `${status} · ${ellipsis(goal, 40)}` : status, enabled: false },
        ...(waiting > 0
          ? [{ label: t("presence.waiting", { count: waiting }), click: () => this.controls.show() } as const]
          : []),
        { type: "separator" },
        { label: t("presence.show"), click: () => this.controls.show() },
        {
          label: paused ? t("composer.resume") : t("composer.pause"),
          enabled: running,
          click: () => (paused ? this.controls.resume() : this.controls.pause()),
        },
        { label: t("composer.stop"), enabled: running, click: () => this.controls.stop() },
        { label: t("presence.emergency"), accelerator: "CommandOrControl+Shift+Escape", click: () => this.controls.emergencyStop() },
        { type: "separator" },
        { label: t("presence.quit"), role: "quit" },
      ]),
    );
  }

  private icon(): NativeImage {
    const img = nativeImage.createFromPath(join(this.iconDir, "trayTemplate.png"));
    img.setTemplateImage(true); // follows the menu bar's light/dark
    return img;
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

function ellipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
