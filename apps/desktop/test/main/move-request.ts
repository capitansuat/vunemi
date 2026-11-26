/**
 * Test helpers for vunemi-move: requests built the way safe-move.ts builds
 * them (identity and parents from Node's own bigint stat), and a way to run
 * the program on one.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { moveBinary } from "../../src/main/native-move.js";

export type Reply = { status: string; reasonCode?: string };

/** The built program, or an error that says how to build it. */
export function program(build: string): string {
  const bin = moveBinary({ packaged: false, resourcesPath: "", home: homedir() });
  if (!bin) throw new Error(`vunemi-move is not built: build it: ${build}`);
  return bin;
}

export function identityOf(path: string) {
  const s = lstatSync(path, { bigint: true });
  return {
    device: String(s.dev), inode: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs),
    sha256: s.isFile() && s.size < 300_000_000n ? createHash("sha256").update(readFileSync(path)).digest("hex") : "0".repeat(64),
  };
}

export function parentsOf(path: string) {
  const out = [];
  for (let at = dirname(path); ; ) {
    const s = lstatSync(at, { bigint: true });
    out.push({ path: at, device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), mode: Number(s.mode) });
    const next = dirname(at);
    if (next === at) break;
    at = next;
  }
  return out.reverse();
}

export function requestFor(source: string, destination: string, change: Record<string, unknown> = {}) {
  return { operationId: randomUUID(), ownerId: "run-1", source, destination, sourceIdentity: identityOf(source), sourceParents: parentsOf(source), destinationParents: parentsOf(destination), ...change };
}

/** Runs `--move` on raw stdin text. */
export function runRaw(bin: string, input: string, env: NodeJS.ProcessEnv = process.env): { reply: Reply; code: number | null } {
  const r = spawnSync(bin, ["--move"], { input, encoding: "utf8", env, windowsHide: true, timeout: 30_000 });
  return { reply: JSON.parse(r.stdout.trim()) as Reply, code: r.status };
}

export const run = (bin: string, request: unknown) => runRaw(bin, `${JSON.stringify(request)}\n`).reply;

/** Starts a move that stops at the test gate; `at()` resolves when it is there, `release()` lets it go on. */
export function gated(bin: string, request: unknown, gate: string) {
  const child = spawn(bin, ["--move"], { env: { ...process.env, VUNEMI_MOVE_TEST_GATE: gate }, windowsHide: true });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const at = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (c: Buffer) => c.toString("utf8").includes("gate") && resolve());
    child.once("close", () => reject(new Error(`ended before the gate: ${out}`)));
  });
  const done = new Promise<Reply>((resolve) => child.once("close", () => resolve(JSON.parse(out.trim()) as Reply)));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return { at, done };
}
