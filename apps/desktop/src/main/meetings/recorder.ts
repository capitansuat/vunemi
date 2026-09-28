/**
 * The bridge to VunemiRecorder, the signed Swift program that records a
 * meeting. One JSON object per line each way, ids matched to replies, like
 * the helper.
 *
 * It is started for a recording and ended with it: closing its input stops
 * the recording, so Vunemi going away never leaves the microphone on.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Microphone {
  id: string;
  name: string;
  default: boolean;
}

export interface Levels {
  me: number;
  others: number;
}

const CALL_TIMEOUT_MS = 15_000;
/** How long a closed recorder gets to write out what it holds. */
const EXIT_GRACE_MS = 3_000;

export function recorderBinary(opts: { packaged: boolean; resourcesPath: string; repo: string }): string | null {
  const path = opts.packaged
    ? join(opts.resourcesPath, "VunemiRecorder")
    : join(opts.repo, "native", "VunemiRecorder", ".build", "release", "VunemiRecorder");
  return existsSync(path) ? path : null;
}

export class Recorder {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** `onExit` hears of a recorder that ended on its own, e.g. a crash mid-meeting. */
  constructor(
    private readonly binary: string | null,
    private readonly onExit: (code: number | null) => void = () => {},
  ) {}

  available(): boolean {
    return this.binary !== null;
  }

  async devices(): Promise<Microphone[]> {
    const { microphones } = (await this.call("devices")) as { microphones: Microphone[] };
    return microphones;
  }

  async start(dir: string, microphone?: string): Promise<void> {
    // macOS may ask for permissions first; the user needs time to answer.
    await this.call("start", { dir, ...(microphone && { microphone }) }, 120_000);
  }

  async levels(): Promise<Levels> {
    return (await this.call("levels")) as Levels;
  }

  async stop(): Promise<{ seconds: number }> {
    const { seconds } = (await this.call("stop")) as { seconds: number };
    return { seconds };
  }

  /** Ends the recorder. Its input closing stops a recording and keeps what was written. */
  dispose(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), EXIT_GRACE_MS);
    child.once("exit", () => clearTimeout(timer));
  }

  // -- internals -------------------------------------------------------------

  private call(op: string, args: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.binary) return Promise.reject(new Error("unavailable"));
    const child = this.spawn(this.binary);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timeout: ${op}`));
      }, timeoutMs);
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

  private spawn(binary: string): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => console.error("[vunemi recorder]", chunk.toString().trim()));
    // A closed pipe after exit is reported by "exit"; don't let it throw.
    child.stdin.on("error", () => {});
    const gone = (error: Error, code: number | null) => {
      const ours = this.child === child;
      if (ours) this.child = null;
      for (const [id, pending] of this.waiting) {
        this.waiting.delete(id);
        pending.reject(error);
      }
      if (ours) this.onExit(code);
    };
    child.on("exit", (code) => gone(new Error(`exited: ${code ?? "signal"}`), code));
    child.on("error", (err) => gone(new Error(`unavailable: ${err.message}`), null));
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
      return;
    }
    const pending = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
    if (!pending || typeof message.id !== "number") return;
    this.waiting.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? "failed"));
  }
}
