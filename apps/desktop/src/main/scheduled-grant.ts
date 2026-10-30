/**
 * What a scheduled task may do because the user allowed it when setting it up:
 * act in the apps they named, change the files they named, with no card when it
 * runs. Saved files and the controls that leave the mouse and keyboard alone go
 * straight away, even with the user at the Mac; only a step that needs the mouse
 * and keyboard waits for them to leave it alone.
 *
 * The apps themselves are enforced where every desktop tool finds its target
 * (createDesktopTools onlyApps), and here only what this run may have.
 */

import { execFile } from "node:child_process";
import type { StandingGrant } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { Automation } from "./automations.js";

const LEAVES_INPUT_ALONE = new Set(["desktop_background_click", "desktop_background_set_text", "desktop_background_append_text", "desktop_background_scroll_position", "desktop_background_menu_open", "desktop_background_menu_select"]);
const TAKES_INPUT = new Set(["desktop_describe", "desktop_focus", "desktop_click", "desktop_type", "desktop_key"]);
/** Tools whose whole effect is on the files their path arguments name. */
const FILE_TOOLS = new Set(["files_write", "files_edit", "excel_read_range", "excel_write_range", "word_read", "word_export_pdf", "powerpoint_outline", "document_make", "document_convert", "document_read", "document_edit", "sheet_make", "slides_make", "slides_read", "slides_edit"]);
const PATH_ARGS = ["path", "out", "output", "input", "source", "from", "to"];
export const IDLE_SECONDS = 10;
export const IDLE_WAIT_MS = 30 * 60_000;
const POLL_MS = 5_000;

export interface GrantDeps {
  permitted(): Promise<boolean>;
  /** Seconds since the user last touched the mouse or keyboard. */
  inputIdle(): Promise<number>;
  unlocked(): Promise<boolean>;
  /** The Mac control part of the connection is on. */
  controlOn(): boolean;
  /** A path as the file tools would resolve it; throws when it is outside the allowed folders. */
  resolve(path: string): string;
  onUncertain(): void;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** Undefined for a task with nothing allowed: it runs as scheduled tasks always have. */
export function createStandingGrant(item: Pick<Automation, "apps" | "files">, deps: GrantDeps): (StandingGrant & { covered: string[] }) | undefined {
  const apps = item.apps ?? [], files = item.files ?? [];
  if (apps.length === 0 && files.length === 0) return undefined;
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? wait;
  let lookedQuietly = false;

  const inside = (path: string): boolean => files.some((file) => path === file || path.startsWith(`${file}/`));
  const fileAllowed = (args: unknown): boolean => {
    const a = (args ?? {}) as Record<string, unknown>;
    const named = PATH_ARGS.map((key) => a[key]).filter((value) => value !== undefined);
    return named.length > 0 && named.every((value) => {
      try {
        return typeof value === "string" && inside(deps.resolve(value));
      } catch {
        return false;
      }
    });
  };
  /** Until the Mac has been left alone and unlocked; false after the limit. */
  const quiet = async (signal: AbortSignal): Promise<boolean> => {
    const deadline = now() + IDLE_WAIT_MS;
    for (;;) {
      if (signal.aborted) return true;
      const ready = await Promise.all([deps.inputIdle(), deps.unlocked()]).then(([idle, unlocked]) => idle >= IDLE_SECONDS && unlocked, () => false);
      if (ready) return true;
      if (now() >= deadline) return false;
      await sleep(POLL_MS, signal);
    }
  };

  const covered = apps.length === 0 ? [] : [...LEAVES_INPUT_ALONE, ...TAKES_INPUT];
  return {
    covered,
    covers: (tool) => covered.includes(tool),
    allows: async (tool, args) => (apps.length > 0 && (LEAVES_INPUT_ALONE.has(tool) || TAKES_INPUT.has(tool))) || (FILE_TOOLS.has(tool) && fileAllowed(args)),
    async before(tool, _args, signal) {
      if (!tool.startsWith("desktop_") || apps.length === 0) return null;
      if (LEAVES_INPUT_ALONE.has(tool) || TAKES_INPUT.has(tool)) {
        if (!deps.controlOn()) return { stop: t("automations.stop.off") };
      }
      if (tool === "desktop_apps" || tool === "desktop_software_updates" || tool === "desktop_operation_status") return null;
      if (!(await deps.permitted().catch(() => false))) return { stop: t("automations.stop.permission") };
      if (tool === "desktop_background_describe") lookedQuietly = true;
      if (!TAKES_INPUT.has(tool)) return null;
      if (!lookedQuietly) return { refuse: `${tool} takes the mouse and keyboard away from the user. Read the app with desktop_background_describe first and use a desktop_background_* tool for whatever it lists. Nothing was done.` };
      if (!(await quiet(signal))) return { stop: t("automations.stop.busy", { minutes: IDLE_WAIT_MS / 60_000 }) };
      return null;
    },
    onUncertain: deps.onUncertain,
  };
}

/** The allowed apps that aren't open, started without coming to the front. */
export async function openQuietly(item: Pick<Automation, "apps">, running: () => Promise<{ bundleId: string }[]>, signal: AbortSignal, sleep = wait): Promise<void> {
  const open = new Set((await running().catch(() => [])).map((app) => app.bundleId));
  const closed = (item.apps ?? []).filter((app) => !open.has(app.bundleId));
  if (closed.length === 0) return;
  await Promise.all(closed.map((app) => new Promise<void>((resolve) => execFile("/usr/bin/open", ["-g", "-b", app.bundleId], () => resolve()))));
  for (let tries = 0; tries < 10 && !signal.aborted; tries++) {
    await sleep(1_500, signal);
    const now = new Set((await running().catch(() => [])).map((app) => app.bundleId));
    if (closed.every((app) => now.has(app.bundleId))) return;
  }
}
