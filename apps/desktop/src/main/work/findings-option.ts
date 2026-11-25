/**
 * A run's findings option (RunOptions.findings), on its own: the session
 * process reads it without loading the stores behind work/findings.ts.
 */
import type { ToolRegistry } from "@vunemi/agent-core";

/** The tools whose output shows a page, counted for the reminder to keep findings. */
const PAGE_TOOLS = ["page_read", "page_describe", "page_goto", "page_click", "page_back", "page_scroll"];

/** While web_finding_add is offered: the tool and the page tools the reminder counts. */
export function findingsOption(tools: ToolRegistry): { tool: string; pages: ReadonlySet<string> } | undefined {
  return tools.get("web_finding_add") ? { tool: "web_finding_add", pages: new Set(PAGE_TOOLS) } : undefined;
}
