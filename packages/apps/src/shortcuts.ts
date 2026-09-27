/**
 * The user's own shortcuts, through the Shortcuts Events scripting
 * dictionary. Vunemi can list them (name, subtitle, number of steps, whether
 * one takes input) and run one; it can't see inside a shortcut, so a run is
 * treated like sending something out: it asks every time, and the card
 * offers to show the shortcut in the Shortcuts app first.
 */

import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { ScriptRunner } from "./runner.js";

const APP = "Shortcuts";
const MAX_LIST = 100;
const MAX_OUTPUT = 20_000;
const MAX_INPUT = 5_000;
/** A shortcut may wait on the network or on a dialog of its own. */
export const SHORTCUT_TIMEOUT_MS = 120_000;

export const SHORTCUTS_LIST = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var s = Application("com.apple.shortcuts.events").shortcuts;
  var names = s.name(), subs = s.subtitle(), steps = s.actionCount(), inputs = s.acceptsInput();
  var folders = [];
  try { folders = s.folder.name(); } catch (_) {}
  var q = String(a.query || "").toLowerCase();
  var out = [];
  for (var i = 0; i < names.length && out.length < a.limit; i++) {
    var sub = subs[i] || "";
    if (q && String(names[i]).toLowerCase().indexOf(q) < 0 && String(sub).toLowerCase().indexOf(q) < 0) continue;
    var item = { name: names[i], steps: steps[i], takesInput: inputs[i] === true };
    if (sub) item.subtitle = sub;
    if (folders[i]) item.folder = folders[i];
    out.push(item);
  }
  return JSON.stringify({ total: names.length, shortcuts: out });
}`;

export const SHORTCUT_RUN = `
function show(v, depth) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return depth > 1 ? "[list]" : v.slice(0, 50).map(function (x) { return show(x, depth + 1); });
  try { return String(v); } catch (_) { return "[unreadable]"; }
}
function run(argv) {
  var a = JSON.parse(argv[0]);
  var found = Application("com.apple.shortcuts.events").shortcuts.whose({ name: a.name })();
  if (found.length === 0) return JSON.stringify({ found: false });
  var result = typeof a.input === "string" ? found[0].run({ withInput: a.input }) : found[0].run();
  return JSON.stringify({ found: true, result: show(result, 0) });
}`;

export const SHORTCUTS_INSTRUCTIONS = `Shortcuts (the user's own, from the Shortcuts app):
- shortcuts_list shows them: name, subtitle, number of steps, whether one takes input. Call it before running one and use the exact name.
- shortcuts_run runs one, with optional text input. Only a shortcut the user asked for by name or clearly meant; never to get around a tool you don't have. It asks the user every time. You can't see what a shortcut does inside, so report only what it returned.`;

interface Listed {
  name: string;
  steps: number;
  takesInput: boolean;
}

/** A shortcut's name: one line, as Shortcuts shows it. */
export function shortcutName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error("name must be a shortcut name from shortcuts_list.");
  return name;
}

export function createShortcutTools(run: ScriptRunner): ToolDef[] {
  // What the last listing said, so the card can show a shortcut's size without asking macOS first.
  const seen = new Map<string, Listed>();
  return [
    {
      name: "shortcuts_list",
      description: "List the user's shortcuts from the Shortcuts app: name, subtitle, number of steps, whether it takes input. Optionally only those whose name or subtitle contains a word.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      actionClass: "read",
      alwaysAsk: true,
      allowSessionApproval: true,
      approvalScope: () => "mac-app:shortcuts",
      untrustedOutput: true,
      preview: async () => t("connectors.apps.requestPreview", { app: APP }),
      async run(a) {
        const query = String(a.query ?? "").trim().slice(0, 100);
        const result = (await run(SHORTCUTS_LIST, { app: APP, query, limit: MAX_LIST })) as { total: number; shortcuts: Listed[] };
        for (const item of result.shortcuts) seen.set(item.name, item);
        if (result.total === 0) return "The user has no shortcuts.";
        if (result.shortcuts.length === 0) return `None of the ${result.total} shortcuts matches "${query}".`;
        return bounded(result);
      },
    },
    {
      name: "shortcuts_run",
      description: "Run one of the user's shortcuts by its exact name, with optional text input. Asks the user every time.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, input: { type: "string", description: "Text passed to a shortcut that takes input" } },
        required: ["name"],
      },
      // Vunemi can't see what the steps do: they may send, post or delete.
      actionClass: "outbound",
      alwaysAsk: true,
      preview: async (a) => {
        const name = String(a.name ?? "").slice(0, 200);
        const input = typeof a.input === "string" && a.input ? t("apps.shortcuts.input", { text: a.input.slice(0, 300) }) : t("apps.shortcuts.noInput");
        const known = seen.get(name);
        const head = known
          ? t("apps.shortcuts.run", { name, steps: t("apps.shortcuts.steps", { count: known.steps }), input })
          : t("apps.shortcuts.runUnlisted", { name, input });
        return `${head} ${t("apps.shortcuts.unseen")}`;
      },
      async run(a, ctx) {
        const name = shortcutName(a.name);
        let input: string | undefined;
        if (a.input !== undefined && a.input !== null && a.input !== "") {
          input = String(a.input);
          if (input.length > MAX_INPUT) throw new Error(`input must be at most ${MAX_INPUT} characters.`);
        }
        const result = (await run(SHORTCUT_RUN, { app: APP, name, ...(input !== undefined && { input }) }, { timeoutMs: SHORTCUT_TIMEOUT_MS, signal: ctx.signal })) as { found: boolean; result?: unknown };
        if (!result.found) return `There is no shortcut named "${name}". Call shortcuts_list and use an exact name.`;
        if (result.result === null || result.result === undefined || result.result === "") return `Ran "${name}". It returned nothing.`;
        return `Ran "${name}". It returned:\n${bounded(result.result)}`;
      },
    },
  ];
}

function bounded(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[truncated]` : s;
}
