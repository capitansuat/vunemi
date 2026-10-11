/**
 * A job: one piece of work an add-on's program does. It gets a folder of its
 * own, the only place besides its own files that the program can read or
 * write (see sandbox.ts). Vunemi copies what the program needs into the
 * folder, runs it, takes out what it made, and removes the folder.
 */

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddonId } from "../../shared/ipc.js";
import { runSandboxed, type SandboxResult } from "./sandbox.js";

export interface EngineJob {
  /** The job's folder. */
  dir: string;
  /** Runs the add-on's program there. */
  run(args: readonly string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<SandboxResult>;
}

/** Runs `work` with a fresh job for one add-on. Refuses when the add-on is not installed. */
export type Engines = <T>(id: AddonId, signal: AbortSignal, work: (job: EngineJob) => Promise<T>) => Promise<T>;

export interface EnginesOptions {
  addons: { binary(id: AddonId): string | null; engineDir(id: AddonId): string };
  /** The user's home folder, which the program may not read. */
  home: string;
  /** Where job folders are made. */
  jobsDir: string;
  /** Replaced in tests. */
  run?: typeof runSandboxed;
}

export function createEngines(opts: EnginesOptions): Engines {
  const run = opts.run ?? runSandboxed;
  return async (id, signal, work) => {
    const program = opts.addons.binary(id);
    if (!program) throw new Error("This add-on is not installed. The user can download it in Settings › Add-ons.");
    mkdirSync(opts.jobsDir, { recursive: true });
    // The real path: the sandbox compares paths as the system resolves them.
    const dir = realpathSync(mkdtempSync(join(opts.jobsDir, "job-")));
    try {
      return await work({
        dir,
        run: (args, o = {}) => run(program, args, { home: opts.home, job: dir, engineDir: opts.addons.engineDir(id), signal, ...o }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Job folders a crash or a forced quit left behind. */
export function clearJobs(jobsDir: string): void {
  let names: string[];
  try {
    names = readdirSync(jobsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith("job-")) rmSync(join(jobsDir, name), { recursive: true, force: true });
  }
}
