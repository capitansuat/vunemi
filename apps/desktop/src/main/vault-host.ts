/**
 * Starts the Vault process and keeps it running. Electron allows a utility
 * process only once the app is ready, so until then the VaultClient reads as
 * locked and everything that needs a secret waits for `ready`.
 *
 * If the process dies, calls in flight fail (a send in flight is reported as
 * an unknown outcome by the outbox, never retried) and a new one is started,
 * at most a few times a minute.
 */
import { VaultClient, type Port, type VaultState } from "@vunemi/vault";

/** The part of Electron's UtilityProcess this needs; a fake in tests. */
export interface ChildProcessLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface VaultHostOptions {
  spawn: () => ChildProcessLike;
  init: () => { userData: string; helperPath: string; locale: string };
  /** Long enough for the user to answer a keychain prompt. */
  startTimeoutMs?: number;
  maxRestartsPerMinute?: number;
  log?: (line: string) => void;
}

export class VaultHost {
  readonly client = new VaultClient();
  private child: ChildProcessLike | null = null;
  private stopping = false;
  private restarts: number[] = [];
  private firstReady!: () => void;
  /** Settles when the Vault process first answered; locked or not, it answered. */
  readonly ready: Promise<void> = new Promise((resolve) => { this.firstReady = resolve; });

  constructor(private readonly opts: VaultHostOptions) {}

  async start(): Promise<void> {
    if (this.child || this.stopping) return;
    const child = this.opts.spawn();
    this.child = child;
    const handlers: ((message: unknown) => void)[] = [];
    const port: Port = {
      post: (message) => child.postMessage(message),
      onMessage: (handler) => { handlers.push(handler); },
    };
    let settle!: (state: VaultState | null) => void;
    const started = new Promise<VaultState | null>((resolve) => { settle = resolve; });
    child.on("message", (message) => {
      const ready = message as { kind?: unknown; state?: VaultState };
      if (ready?.kind === "ready") settle(ready.state ?? null);
      else for (const handler of handlers) handler(message);
    });
    child.on("exit", (code) => {
      settle(null);
      if (this.child !== child) return;
      this.child = null;
      this.client.detach(`Vault process exited (${code})`);
      if (this.stopping) return;
      this.opts.log?.(`[vunemi] vault process exited (${code})`);
      this.restartLater();
    });
    child.postMessage({ kind: "init", ...this.opts.init() });
    const timeout = setTimeout(() => settle(null), this.opts.startTimeoutMs ?? 300_000);
    const state = await started;
    clearTimeout(timeout);
    if (this.child !== child) return;
    if (!state) {
      this.opts.log?.("[vunemi] vault process did not start");
      child.kill();
      return;
    }
    this.client.attach(port);
    await this.client.refresh().catch(() => undefined);
    this.firstReady();
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
    this.client.detach("Vunemi is quitting");
    this.firstReady();
  }

  private restartLater(): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < 60_000);
    if (this.restarts.length >= (this.opts.maxRestartsPerMinute ?? 3)) {
      this.opts.log?.("[vunemi] vault process keeps exiting; not restarting it again");
      this.firstReady();
      return;
    }
    this.restarts.push(now);
    const timer = setTimeout(() => void this.start(), 1_000);
    timer.unref?.();
  }
}
