/**
 * How files_move reaches the native code that moves the file: on macOS the
 * Swift helper (renameatx_np with RENAME_EXCL), on Linux and Windows the small
 * vunemi-move program (native/move). Each moves one approved file without
 * ever replacing anything; this module only carries the request there and
 * the answer back, and tells "never sent" (not moved) from "sent, then lost"
 * (unknown), because only the first is safe to call a refusal.
 */
import { spawn } from "node:child_process";
import type { AtomicMoveAdapter, AtomicMoveRequest, AtomicMoveResult } from "@vunemi/files";
import { withJournalAdmission, type Helper } from "@vunemi/mac";
import type { Platform } from "@vunemi/platform";
import { builtBinary, type BinaryLookup } from "./engine/binary.js";
import { windowsJournalAdmission } from "./journal-windows.js";

/** native/move's protocol version; the build scripts' cache folder carries it. */
export const MOVE_VERSION = "1";

/** vunemi-move: in the app's resources, or a development run's build cache. */
export function moveBinary(opts: BinaryLookup): string | null {
  return builtBinary(opts, "vunemi-move", "move-cache", MOVE_VERSION);
}

const REASON = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_REPLY = 4096;
const TIMEOUT_MS = 30_000;

/** One receipt, or unknown: a reply that isn't exactly one of the three shapes proves nothing. */
export function receipt(value: unknown): AtomicMoveResult {
  if (value && typeof value === "object") {
    const r = value as { status?: unknown; reasonCode?: unknown };
    if (r.status === "moved") return { status: "moved" };
    if ((r.status === "not-moved" || r.status === "unknown") && typeof r.reasonCode === "string" && REASON.test(r.reasonCode)) return { status: r.status, reasonCode: r.reasonCode };
  }
  return { status: "unknown", reasonCode: "invalid-native-receipt" };
}

const plan = ({ operationId, ownerId, source, destination, sourceIdentity, sourceParents, destinationParents }: AtomicMoveRequest) =>
  ({ operationId, ownerId, source, destination, sourceIdentity, sourceParents, destinationParents });

/**
 * Runs `program --move` once a move. The request goes as one line of JSON on
 * stdin. A stop asked for before the program starts stops it; once the
 * request is on its way the move is not interrupted, since killing it halfway
 * would leave an unknown move where a finished one was a moment away.
 */
export function programMoveAdapter(program: string, opts: { timeoutMs?: number; programArgs?: string[] } = {}): AtomicMoveAdapter {
  return {
    move(request) {
      if (request.signal?.aborted) return Promise.resolve({ status: "not-moved", reasonCode: "stopped" });
      return new Promise<AtomicMoveResult>((resolve) => {
        let out = "";
        let sent = false;
        let settled = false;
        const finish = (result: AtomicMoveResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const child = spawn(program, [...(opts.programArgs ?? []), "--move"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ status: "unknown", reasonCode: "native-transport-uncertain" });
        }, opts.timeoutMs ?? TIMEOUT_MS);
        // Never started (missing, not executable): the request never left this process.
        child.once("error", () => finish(sent ? { status: "unknown", reasonCode: "native-transport-uncertain" } : { status: "not-moved", reasonCode: "native-admission-refused" }));
        child.once("spawn", () => {
          sent = true;
          child.stdin!.on("error", () => {});
          child.stdin!.end(`${JSON.stringify(plan(request))}\n`);
        });
        child.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          if (out.length > MAX_REPLY) {
            child.kill("SIGKILL");
            finish({ status: "unknown", reasonCode: "invalid-native-receipt" });
          }
        });
        child.once("close", () => {
          if (!out) return finish({ status: "unknown", reasonCode: "native-transport-uncertain" });
          const lines = out.split("\n").filter(Boolean);
          if (lines.length !== 1) return finish({ status: "unknown", reasonCode: "invalid-native-receipt" });
          try {
            finish(receipt(JSON.parse(lines[0]!)));
          } catch {
            finish({ status: "unknown", reasonCode: "invalid-native-receipt" });
          }
        });
      });
    },
  };
}

/** The Swift helper's move: today's mapping, unchanged. */
export function helperMoveAdapter(helper: Helper): AtomicMoveAdapter {
  return {
    async move(request) {
      const { signal, assertActive, ...payload } = request;
      try {
        return receipt(await helper.call("filesystem_move_noreplace", payload, { signal, assertActive, ownerRunId: request.ownerId }));
      } catch (error) {
        if (error && typeof error === "object" && "noInputSent" in error && error.noInputSent === true) return { status: "not-moved", reasonCode: "native-admission-refused" };
        return { status: "unknown", reasonCode: "native-transport-uncertain" };
      }
    },
  };
}

export type JournalAdmission = <T>(path: string, body: (assertCurrent: () => void) => Promise<T> | T, signal?: AbortSignal) => Promise<T>;

/** The move and its journal lock on this system, or null where neither is there. */
export function nativeMove(on: Platform, helper: Helper, lookup: BinaryLookup): { adapter: AtomicMoveAdapter; admit: JournalAdmission } | null {
  if (on.id === "darwin") return { adapter: helperMoveAdapter(helper), admit: (path, body, signal) => helper.admitJournal(path, body, signal) };
  const program = moveBinary({ ...lookup, system: on.id });
  if (!program) return null;
  return {
    adapter: programMoveAdapter(program),
    // Windows lets a process's locks go when it exits, so its lock is the app's own exclusive open.
    admit: on.id === "win32" ? windowsJournalAdmission : (path, body, signal) => withJournalAdmission(program, path, body, signal),
  };
}
