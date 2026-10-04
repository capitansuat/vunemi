import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/**
 * Runs the built-in model server. One process at a time, on 127.0.0.1 with a
 * fresh port and key each launch, so nothing else on the Mac can talk to it.
 * A loaded model holds gigabytes, so the process goes when Vunemi has had
 * nothing to do for a while, and comes back on the next task.
 */

export type EngineStateName = "absent" | "idle" | "starting" | "ready" | "failed";

export interface EngineSnapshot {
  state: EngineStateName;
  model: string | null;
  error?: string;
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
}

export interface LaunchSpec {
  id: string;
  path: string;
  context: number;
  /** The vision part, when the model has one on disk. */
  projector?: string;
  /** Serves embeddings instead of chat, one sequence at a time, pooled this way. */
  pooling?: "mean" | "last";
}

export interface EngineOptions {
  /** The llama-server binary; null when this build has none. */
  binary: string | null;
  /** True while a task runs or waits: then the engine is never unloaded. */
  isBusy: () => boolean;
  onChange?: (s: EngineSnapshot) => void;
  idleMs?: number;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Where the running server's pid is kept. macOS does not stop a child when
   * its parent dies, so after a crash the server would hold its gigabytes
   * until someone noticed; the next Vunemi reads this and stops it.
   */
  pidFile?: string;
}

const IDLE_MS = 15 * 60_000;
const READY_MS = 3 * 60_000;
const STOP_GRACE_MS = 3_000;

export function serverArgs(spec: LaunchSpec, port: number, apiKey: string): string[] {
  if (spec.pooling) {
    // The whole context goes to one sequence, and a sequence must fit one batch.
    const n = String(spec.context);
    return [
      "-m", spec.path, "--host", "127.0.0.1", "--port", String(port), "--api-key", apiKey,
      "--embedding", "--pooling", spec.pooling, "-c", n, "-b", n, "-ub", n, "-np", "1", "-ngl", "999", "--no-webui",
    ];
  }
  return [
    "-m", spec.path, "--host", "127.0.0.1", "--port", String(port), "--api-key", apiKey,
    "--jinja", "-c", String(spec.context), "-fa", "on", "-ngl", "999", "--no-webui",
    ...(spec.projector ? ["--mmproj", spec.projector] : []),
  ];
}

function sameLaunch(a: LaunchSpec, b: LaunchSpec): boolean {
  return a.id === b.id && a.path === b.path && a.context === b.context && a.projector === b.projector && a.pooling === b.pooling;
}

export class Engine {
  private state: EngineSnapshot;
  private child: ChildProcess | null = null;
  private current: { spec: LaunchSpec; endpoint: Endpoint } | null = null;
  private starting: Promise<Endpoint> | null = null;
  /** A launch asked for but not begun yet (the previous process is still stopping). */
  private queued: { spec: LaunchSpec; promise: Promise<Endpoint> } | null = null;
  private restarts = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: EngineOptions) {
    this.state = { state: opts.binary ? "idle" : "absent", model: null };
    if (opts.pidFile && opts.binary) reapStale(opts.pidFile, opts.binary);
  }

  get snapshot(): EngineSnapshot {
    return { ...this.state };
  }

  endpoint(id: string): Endpoint | null {
    return this.state.state === "ready" && this.current?.spec.id === id ? this.current.endpoint : null;
  }

  /** The server's process while one runs or starts, for measuring its memory. */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** What the running (or starting) server was launched with. */
  loaded(): LaunchSpec | null {
    return this.current?.spec ?? null;
  }

  ensure(spec: LaunchSpec): Promise<Endpoint> {
    if (!this.opts.binary) return Promise.reject(new Error("This Vunemi has no built-in engine."));
    this.touch();
    // The same model with another context length is a new launch.
    if (this.current && sameLaunch(this.current.spec, spec)) {
      if (this.state.state === "ready") return Promise.resolve(this.current.endpoint);
      if (this.starting) return this.starting;
    }
    // Two callers asking at once get the same launch, not two processes.
    if (this.queued && sameLaunch(this.queued.spec, spec)) return this.queued.promise;
    const promise = this.stop().then(() => {
      this.restarts = 0;
      return this.launch(spec);
    });
    const queued = { spec, promise };
    this.queued = queued;
    void promise.finally(() => {
      if (this.queued === queued) this.queued = null;
    }).catch(() => {});
    return promise;
  }

  /** Something happened: the idle clock starts again. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), this.opts.idleMs ?? IDLE_MS);
    this.idleTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (this.opts.pidFile) rmSync(this.opts.pidFile, { force: true });
    // Cleared first, so the exit that follows is not taken for a crash.
    this.child = null;
    this.current = null;
    this.starting = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = once(child, "exit");
      const late = new Promise((r) => setTimeout(r, STOP_GRACE_MS).unref());
      if ((await Promise.race([exited.then(() => "exited"), late])) !== "exited") child.kill("SIGKILL");
    }
    if (this.state.state !== "absent" && this.state.state !== "idle") this.set({ state: "idle", model: null });
  }

  private launch(spec: LaunchSpec): Promise<Endpoint> {
    this.set({ state: "starting", model: spec.id });
    const started = this.start(spec).then(
      (endpoint) => {
        this.set({ state: "ready", model: spec.id });
        this.touch();
        return endpoint;
      },
      (err: unknown) => {
        const child = this.child;
        this.child = null;
        this.current = null;
        child?.kill("SIGKILL");
        const message = err instanceof Error ? err.message : String(err);
        this.set({ state: "failed", model: spec.id, error: message });
        throw err;
      },
    );
    this.starting = started;
    void started.finally(() => {
      if (this.starting === started) this.starting = null;
    }).catch(() => {});
    return started;
  }

  private async start(spec: LaunchSpec): Promise<Endpoint> {
    const port = await freePort();
    const apiKey = randomBytes(24).toString("hex");
    const endpoint = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey };
    const child = spawn(this.opts.binary!, serverArgs(spec, port, apiKey), {
      stdio: ["ignore", "ignore", "pipe"],
      env: this.opts.env ?? process.env,
    });
    this.child = child;
    this.current = { spec, endpoint };
    if (this.opts.pidFile && child.pid) writeFileSync(this.opts.pidFile, String(child.pid));
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-4_000); });
    let exited = false;
    child.once("exit", () => {
      exited = true;
      this.onExit(child, tail);
    });
    child.once("error", () => { exited = true; });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? READY_MS);
    while (Date.now() < deadline) {
      if (exited) throw new Error(lastLine(tail) || "The engine stopped while loading the model.");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return endpoint;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The engine did not get ready in time.");
  }

  private onExit(child: ChildProcess, tail: string): void {
    if (child !== this.child) return; // stopped on purpose, or replaced
    const spec = this.current?.spec;
    this.child = null;
    this.current = null;
    if (this.state.state !== "ready" || !spec) return; // a failed start is handled by start()
    if (this.restarts < 1) {
      this.restarts++;
      void this.launch(spec).catch(() => {});
      return;
    }
    this.set({ state: "failed", model: spec.id, error: lastLine(tail) || "The engine stopped unexpectedly." });
  }

  private onIdle(): void {
    if (!this.child) return;
    if (this.opts.isBusy()) {
      this.touch();
      return;
    }
    void this.stop();
  }

  private set(state: EngineSnapshot): void {
    this.state = state;
    this.opts.onChange?.(this.snapshot);
  }
}

/** Stops a server a previous Vunemi left running, and nothing else. */
function reapStale(pidFile: string, binary: string): void {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    // By now the pid may belong to anything: only our own engine is stopped.
    if (command.startsWith(`${binary} `) || command.includes(` ${binary} `)) process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}
