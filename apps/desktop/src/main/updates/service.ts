/**
 * Whether a newer Vunemi is out, and getting it when the user asks. The
 * check is ours (a small JSON file on vunemi.com, read with suspicion);
 * the download and the install are Squirrel.Mac's, which installs only an
 * app signed like this one. Nothing here is reachable from the agent.
 */
import type { UpdateError, UpdateStatus } from "../../shared/ipc.js";
import { newer, readFeed, type FeedSource, type Offer } from "./feed.js";

export const DAY = 24 * 60 * 60 * 1000;

/** The part of Electron's autoUpdater this uses; tests pass a stand-in. */
export interface Updater {
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: "update-downloaded", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface UpdateDeps {
  current: string;
  locale: () => string;
  source: FeedSource;
  fetchFeed: (url: string) => Promise<unknown>;
  updater: Updater;
  /** The user wants the daily check. */
  enabled: () => boolean;
  /** Vunemi runs from Applications, where it can replace itself. */
  installable: () => boolean;
  /** Nothing is running that a restart would cut short. */
  idle: () => boolean;
  stagedMatches: () => Promise<boolean | null>;
  now: () => number;
  onChange: (status: UpdateStatus) => void;
}

type Phase = UpdateStatus["phase"];

export class UpdateService {
  private phase: Phase = "idle";
  private offer: Offer | null = null;
  private error: UpdateError | null = null;
  private checkedAt: number | null = null;
  private checking = false;

  constructor(private readonly deps: UpdateDeps) {
    deps.updater.on("update-downloaded", () => this.set("ready"));
    deps.updater.on("error", (err) => {
      if (this.phase !== "downloading" && this.phase !== "ready") return;
      this.set("failed", /signature|requirement|codesign/i.test(err.message) ? "signature" : "download");
    });
  }

  status(): UpdateStatus {
    return { phase: this.phase, offer: this.offer, error: this.error, checkedAt: this.checkedAt, installable: this.deps.installable(), idle: this.deps.idle() };
  }

  /** Sends the status again, for when idleness may have changed. */
  refresh(): void {
    this.deps.onChange(this.status());
  }

  /** The daily check, when it is due and wanted. */
  tick(): void {
    if (!this.deps.enabled() || this.checking) return;
    if (this.phase === "downloading" || this.phase === "ready") return;
    if (this.checkedAt !== null && this.deps.now() - this.checkedAt < DAY) return;
    void this.check(false);
  }

  /** A manual check says "up to date" and names a failure; the daily one keeps quiet. */
  async check(manual: boolean): Promise<UpdateStatus> {
    if (this.phase === "downloading" || this.phase === "ready") return this.status();
    this.checking = true;
    this.checkedAt = this.deps.now();
    try {
      let raw: unknown;
      try {
        raw = await this.deps.fetchFeed(this.deps.source.feed);
      } catch {
        return manual ? this.set("failed", "network") : this.set(this.offer ? "available" : "idle");
      }
      const offer = readFeed(raw, this.deps.current, this.deps.locale(), this.deps.source);
      if (offer) {
        this.offer = offer;
        return this.set("available");
      }
      this.offer = null;
      if (!manual) return this.set("idle");
      const version = (raw as { currentRelease?: unknown } | null)?.currentRelease;
      // Our version or an older one: up to date. A later one we could not use, or nothing readable: the feed is at fault.
      return typeof version === "string" && !newer(version, this.deps.current) ? this.set("current") : this.set("failed", "feed");
    } finally {
      this.checking = false;
    }
  }

  /** Squirrel downloads the offer and checks its signature. Only from Applications. */
  download(): UpdateStatus {
    const retry = this.phase === "failed" && this.offer !== null;
    if ((this.phase !== "available" && !retry) || !this.deps.installable()) return this.status();
    this.deps.updater.setFeedURL({ url: this.deps.source.feed, serverType: "json" });
    this.deps.updater.checkForUpdates();
    return this.set("downloading");
  }

  /** Quits and installs, only when idle and when the staged app is not signed by someone else. */
  async install(): Promise<UpdateStatus> {
    if (this.phase !== "ready" || !this.deps.idle()) return this.status();
    if ((await this.deps.stagedMatches()) === false) return this.set("failed", "signature");
    this.deps.updater.quitAndInstall();
    return this.status();
  }

  private set(phase: Phase, error: UpdateError | null = null): UpdateStatus {
    this.phase = phase;
    this.error = error;
    const status = this.status();
    this.deps.onChange(status);
    return status;
  }
}
