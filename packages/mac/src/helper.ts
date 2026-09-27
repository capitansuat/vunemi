/**
 * The bridge to VunemiHelper, the signed Swift process that holds the
 * Accessibility privilege. One JSON object per line each way, one request at
 * a time, ids matched to replies.
 *
 * The helper is started when it is first needed and restarted if it dies, so
 * a crash costs one call rather than the session. Nothing here decides
 * anything: policy lives in policy.ts and in the Sentinel.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { t } from "@vunemi/i18n";
import { nativeErrorText } from "./native-errors.js";

export interface Permissions {
  accessibility: boolean;
  /** Diagnostic fields returned by the native helper for a failed AX check. */
  trusted?: boolean;
  probe?: string;
  screenRecording: boolean;
  /** Granted separately from everything else, and from each other. */
  calendars: boolean;
  reminders: boolean;
}

export interface MacApp {
  name: string;
  bundleId: string;
  pid: number;
  frontmost: boolean;
}

/** Long enough for an app to answer, short enough that nothing hangs. */
const CALL_TIMEOUT_MS = 20_000;

export class HelperUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperUnavailable";
  }
}

export class Helper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly binary: string) {}

  get installed(): boolean {
    return existsSync(this.binary);
  }

  /**
   * Asked fresh every time, never remembered: macOS grants and revokes these
   * while the app runs, and a cached "granted" turns into an agent that
   * quietly does nothing.
   */
  async permissions(prompt = false): Promise<Permissions> {
    const permissions = (await this.call("permissions", { prompt })) as Permissions;
    return permissions.probe ? { ...permissions, probe: nativeErrorText(permissions.probe) } : permissions;
  }

  async apps(): Promise<MacApp[]> {
    const { apps } = (await this.call("apps")) as { apps: MacApp[] };
    return apps;
  }

  async call(op: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.installed) {
      throw new HelperUnavailable(
        t("mac.helper.missing"),
      );
    }
    const child = this.start();
    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(t("mac.helper.timeout", { op })));
      }, opts.timeoutMs ?? CALL_TIMEOUT_MS);

      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }

  // -- internals -------------------------------------------------------------

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";

    child.stdout.on("data", (chunk: Buffer) => this.read(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => console.error("[vunemi helper]", chunk.toString().trim()));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      // Whoever was waiting will never hear back; say so rather than hang.
      for (const [id, pending] of this.waiting) {
        this.waiting.delete(id);
        pending.reject(new Error(t("mac.helper.exited", { code: code ?? "signal" })));
      }
    });
    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      for (const [id, pending] of this.waiting) {
        this.waiting.delete(id);
        pending.reject(new HelperUnavailable(t("mac.helper.spawnFailed", { reason: err.message })));
      }
    });
    return child;
  }

  private read(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim()) this.deliver(line);
    }
  }

  private deliver(line: string): void {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      console.error("[vunemi helper] unreadable reply:", line.slice(0, 200));
      return;
    }
    const pending = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
    if (!pending || typeof message.id !== "number") return;
    this.waiting.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error ? nativeErrorText(message.error) : t("mac.helper.failed")));
  }
}
