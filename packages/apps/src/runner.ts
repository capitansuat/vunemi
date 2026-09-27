/**
 * Runs Vunemi's own Apple Events scripts. The script is always one of the
 * fixed templates in this package; what the model asked for travels as a
 * single JSON argument that the template parses, so no input can become
 * script text. One process per call, killed if it does not answer.
 */

import { spawn } from "node:child_process";
import { t } from "@vunemi/i18n";

export type ScriptLanguage = "JavaScript" | "AppleScript";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ScriptRunner = (template: string, input: unknown, opts?: RunOptions) => Promise<unknown>;

export const SCRIPT_TIMEOUT_MS = 20_000;

/** A failed script, with the macOS error number when there was one. */
export class AppScriptError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
    this.name = "AppScriptError";
  }
}

const DENIED = -1743;
const TIMEOUT = -1712;

/** Turns osascript's stderr into something the user can act on. */
export function friendlyError(raw: string, app: string): AppScriptError {
  const match = /\((-?\d+)\)\s*$/.exec(raw.trim());
  const code = match ? Number(match[1]) : null;
  const detail = raw.replace(/^.*?execution error:\s*(Error:\s*)?/s, "").replace(/\s*\(-?\d+\)\s*$/, "").trim();
  switch (code) {
    case DENIED:
      return new AppScriptError(t("apps.error.denied", { app }), code);
    case -600:
    case -10810:
      return new AppScriptError(t("apps.error.notRunning", { app }), code);
    case TIMEOUT:
      return new AppScriptError(t("apps.error.timeout", { app }), code);
    case -1728:
    case -1719:
      return new AppScriptError(t("apps.error.notFound", { app }), code);
    case -2740:
    case -2741:
    case -10814:
      return new AppScriptError(t("apps.error.notInstalled", { app }), code);
    default:
      return new AppScriptError(t("apps.error.failed", { app, detail: detail || raw.trim() }), code);
  }
}

export function createRunner(opts: {
  osascript?: string;
  language?: ScriptLanguage;
  onDenied?: (app: string) => void;
  onAllowed?: (app: string) => void;
} = {}): ScriptRunner {
  const binary = opts.osascript ?? "/usr/bin/osascript";
  const language = opts.language ?? "JavaScript";
  return (template, input, runOpts = {}) =>
    new Promise((resolve, reject) => {
      const app = String((input as { app?: unknown } | null)?.app ?? "?");
      const child = spawn(binary, ["-l", language, "-e", template, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let settled = false;
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const stop = (e: AppScriptError) =>
        finish(() => {
          child.kill("SIGKILL");
          reject(e);
        });
      const timer = setTimeout(() => stop(new AppScriptError(t("apps.error.timeout", { app }), TIMEOUT)), runOpts.timeoutMs ?? SCRIPT_TIMEOUT_MS);
      runOpts.signal?.addEventListener("abort", () => stop(new AppScriptError(t("apps.error.timeout", { app }), TIMEOUT)), { once: true });
      child.on("error", (e) => stop(new AppScriptError(t("apps.error.failed", { app, detail: e.message }), null)));
      child.on("close", (code) =>
        finish(() => {
          if (code !== 0) {
            const failure = friendlyError(err, app);
            if (failure.code === DENIED) opts.onDenied?.(app);
            reject(failure);
            return;
          }
          opts.onAllowed?.(app);
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new AppScriptError(t("apps.error.failed", { app, detail: out.slice(0, 200) }), null));
          }
        }),
      );
    });
}
