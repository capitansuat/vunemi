import { execFile } from "node:child_process";

/**
 * What macOS says about memory, read with its own tools. A reading is null
 * when the tool is missing or its output is not understood; the model
 * manager then does what Vunemi did before it (see manager.ts).
 */

export type Run = (cmd: string, args: string[]) => Promise<string>;

export interface MemoryReader {
  /** Bytes macOS can hand out now without swapping. */
  available(): Promise<number | null>;
  /** A process's own memory. It leaves out files the process maps, such as a model's weights. */
  footprint(pid: number): Promise<number | null>;
  /** 1 normal, 2 warning, 4 critical. */
  pressure(): Promise<number | null>;
}

const GiB = 1024 ** 3;
/** llama.cpp's compute buffers and the server around the model. */
const OVERHEAD = GiB / 2;
/** The KV cache's share of the file, when the file does not say how large it is per token. */
const KV_SHARE = 0.2;
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const PAGE_KINDS = ["free", "inactive", "speculative", "purgeable"];

/** Free, inactive, speculative and purgeable pages: what macOS gives back at once. */
export function parseVmStat(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) return null;
  let pages = 0;
  for (const kind of PAGE_KINDS) {
    const m = new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.`, "m").exec(text);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return pages * Number(page[1]);
}

export function parseFootprint(text: string): number | null {
  const m = /Footprint:\s+([\d.]+)\s+(B|KB|MB|GB)\b/.exec(text);
  return m ? Math.round(Number(m[1]) * UNITS[m[2]!]!) : null;
}

export function parsePressure(text: string): number | null {
  const level = Number(text.trim());
  return text.trim() !== "" && [1, 2, 4].includes(level) ? level : null;
}

/** What loading a model with this context takes: its file, its KV cache, and the rest. */
export function need(fileBytes: number, kvBytesPerToken: number | null, context: number): number {
  const kv = kvBytesPerToken === null ? fileBytes * KV_SHARE : kvBytesPerToken * context;
  return Math.round(fileBytes + kv + OVERHEAD);
}

const execRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export function macMemory(run: Run = execRun): MemoryReader {
  const read = async (cmd: string, args: string[], parse: (text: string) => number | null): Promise<number | null> => {
    try {
      return parse(await run(cmd, args));
    } catch {
      return null;
    }
  };
  return {
    available: () => read("/usr/bin/vm_stat", [], parseVmStat),
    footprint: (pid) => read("/usr/bin/footprint", ["-p", String(pid)], parseFootprint),
    pressure: () => read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], parsePressure),
  };
}
