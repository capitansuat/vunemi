/**
 * Runs an add-on's program where it can do its one job and nothing else.
 *
 * The programs are other people's, large and young. So each run gets macOS's
 * sandbox around it: no network, the user's home folder closed, and writing
 * allowed only into the job's own folder. Vunemi copies what the program
 * needs into that folder and takes the result out again; the program never
 * sees where either came from.
 */
import { spawn } from "node:child_process";

export interface SandboxPaths {
  /** The user's home folder: closed, apart from the two folders below. */
  home: string;
  /** This run's folder: the only place the program may write. */
  job: string;
  /** Where the program is installed: read only. */
  engineDir: string;
}

export interface SandboxRun extends SandboxPaths {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxResult {
  code: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** A program that prints without end is cut off here; the tools read far less. */
const MAX_OUTPUT = 8_000_000;

const quoted = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The last rule that matches decides, so the two folders are opened after the home folder is closed. */
export function sandboxProfile(p: SandboxPaths): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    // The home folder, and the other places a person's files and other apps' leftovers are.
    `(deny file-read* (subpath ${quoted(p.home)}) (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))`,
    // The loader walks down to the program through the folders above it.
    `(allow file-read-metadata (subpath ${quoted(p.home)}) (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp"))`,
    `(allow file-read* (subpath ${quoted(p.engineDir)}) (subpath ${quoted(p.job)}))`,
    "(deny file-write*)",
    `(allow file-write* (subpath ${quoted(p.job)}) (literal "/dev/null") (literal "/dev/dtracehelper"))`,
  ].join("\n");
}

export function runSandboxed(program: string, args: readonly string[], run: SandboxRun): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const limit = AbortSignal.timeout(run.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile(run), program, ...args], {
      cwd: run.job,
      // Nothing of the user's session: no tokens, no agent sockets, no paths.
      env: { HOME: run.job, TMPDIR: run.job, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
      signal: run.signal ? AbortSignal.any([run.signal, limit]) : limit,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(-MAX_OUTPUT)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-MAX_OUTPUT)));
    child.once("error", (err) => reject(limit.aborted ? new Error("The add-on took too long and was stopped.") : err));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(run.stdin ?? "");
  });
}
