/**
 * Finder: what the user has selected, and showing a file. Both stay inside
 * the folders the file tools may use; a selection elsewhere is counted, not
 * shown, so pointing at a file does not open the rest of the disk.
 */

import type { ToolDef } from "@vunemi/agent-core";
import type { Roots } from "@vunemi/files";
import { t } from "@vunemi/i18n";
import type { ScriptRunner } from "./runner.js";

const APP = "Finder";

export const FINDER_SELECTION = `
function run(argv) {
  JSON.parse(argv[0]);
  var items = Application("com.apple.finder").selection();
  var out = [];
  for (var i = 0; i < items.length; i++) out.push(decodeURIComponent(items[i].url().replace(/^file:\\/\\//, "")).replace(/\\/$/, ""));
  return JSON.stringify(out);
}`;

export const FINDER_REVEAL = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var finder = Application("com.apple.finder");
  finder.reveal(Path(a.path));
  finder.activate();
  return JSON.stringify({ ok: true });
}`;

export const FINDER_INSTRUCTIONS = `Using Finder:
- finder_selection tells you which files the user has selected in Finder, so "this file" can mean their selection.
- finder_reveal opens a Finder window with a file selected, for the user to see.`;

export function createFinderTools(run: ScriptRunner, roots: Roots): ToolDef[] {
  const inside = (path: string): boolean => {
    try {
      roots.resolve(path, "read");
      return true;
    } catch {
      return false;
    }
  };
  return [
    {
      name: "finder_selection",
      description: "List the files and folders the user has selected in Finder right now.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      untrustedOutput: true,
      async run() {
        const paths = (await run(FINDER_SELECTION, { app: APP })) as string[];
        if (paths.length === 0) return "Nothing is selected in Finder.";
        const shown = paths.filter(inside);
        const hidden = paths.length - shown.length;
        const lines = shown.map((p) => `- ${p}`);
        if (hidden > 0) lines.push(`(${hidden} item${hidden === 1 ? " is" : "s are"} outside the folders Vunemi may use and not shown.)`);
        return lines.join("\n");
      },
    },
    {
      name: "finder_reveal",
      description: "Show a file or folder in a Finder window, selected.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "The file or folder, e.g. ~/Documents/report.pdf" } },
        required: ["path"],
      },
      actionClass: "read",
      preview: async (a) => t("apps.finder.reveal", { path: String(a.path ?? "") }),
      async run(a) {
        const path = roots.resolve(String(a.path ?? ""), "read");
        await run(FINDER_REVEAL, { app: APP, path });
        return `Showed ${path} in Finder.`;
      },
    },
  ];
}
