/**
 * Placeholder tools for M0, so the loop, the approval gate and the timeline
 * can be exercised end to end before the browser node (M1) exists.
 */

import { ToolRegistry } from "@ocak/agent-core";
import { t } from "@ocak/i18n";

export function createDemoTools(): ToolRegistry {
  let scratchpad = "";

  return new ToolRegistry()
    .register({
      name: "get_current_time",
      description: "Returns the current local date and time on the user's computer.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      run: async () => {
        const now = new Date();
        return `${now.toString()} (ISO ${now.toISOString()})`;
      },
    })
    .register({
      name: "scratchpad_read",
      description: "Reads the user's scratchpad, a single shared text note.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      run: async () => (scratchpad === "" ? "(the scratchpad is empty)" : scratchpad),
    })
    .register<{ content: string; mode?: "replace" | "append" }>({
      name: "scratchpad_write",
      description:
        "Writes to the user's scratchpad. Use mode 'append' to add a line, 'replace' to overwrite it.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Text to write." },
          mode: { type: "string", enum: ["replace", "append"], description: "Defaults to append." },
        },
        required: ["content"],
      },
      actionClass: "write-local",
      run: async ({ content, mode = "append" }, ctx) => {
        const before = scratchpad;
        scratchpad = mode === "replace" || scratchpad === "" ? content : `${scratchpad}\n${content}`;
        ctx.offerUndo(before === "" ? t("main.demo.empty") : t("main.demo.restore"), async () => {
          scratchpad = before;
        });
        return `Scratchpad updated (${scratchpad.length} characters).`;
      },
    });
}
