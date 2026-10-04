/**
 * The areas of tools the model chooses from at the start of a conversation
 * (see @vunemi/agent-core areas.ts): one per working connection, and one per
 * group of app tools, which app_guide opens. The summaries are for the model,
 * so they are English, and short: they go into every request.
 */
import type { ToolArea } from "@vunemi/agent-core";
import { APP_GROUPS, type AppGroup } from "@vunemi/apps";

const SUMMARIES: Record<string, string> = {
  browser: "the web: search, open and read pages, act on websites",
  files: "files and folders on this Mac: list, find, read, write, move, convert",
  desktop: "the Mac screen: which apps are open, read or click a window, screenshots",
  apps: "Apple Notes, the Finder selection, and other Mac apps: music, messages, contacts, photos, Word, Excel, PowerPoint",
  shortcuts: "the user's own Shortcuts",
  automations: "tasks that run later or repeatedly on a schedule",
  calendar: "the user's calendar events",
  reminders: "the user's reminders",
  mail: "the user's mailbox: find, read, draft, send, organize emails",
  "travel-flights": "flight search",
  "travel-hotels": "hotel search",
};

export function toolAreas(connections: readonly { id: string; label: string; instructions?: string }[], groups: readonly AppGroup[] = APP_GROUPS): ToolArea[] {
  return [
    ...connections.map((c) => ({
      id: c.id,
      summary: SUMMARIES[c.id] ?? c.label,
      ...(c.instructions && { guide: c.instructions }),
      // A schedule is asked for in passing ("every morning, summarise…"):
      // the one tool that sets it up is always there.
      ...(c.id === "automations" && { alwaysShown: ["automation_create"] }),
    })),
    ...groups.map((g) => ({ id: g.id, summary: g.covers, guide: g.guide, routed: false })),
  ];
}
