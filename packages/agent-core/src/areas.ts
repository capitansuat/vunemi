/**
 * Areas of tools, and a tool list that stays the same for a whole
 * conversation. A local server reads the prompt again from the first change
 * on; with ~70 tool definitions that was 11,000 tokens and half a minute.
 * So a conversation lists only the areas its first request needed, and the
 * rest are reached without touching the start of the prompt: their
 * definitions arrive later in the conversation (tools_open, or appended to a
 * request) and are called through tool_run.
 */
import type { ChatModel, ToolSpec } from "./provider.js";
import type { ToolDef, ToolRegistry } from "./tools.js";

export interface ToolArea {
  /** The connection ("mail"), or an on-demand group of app tools ("music"). */
  id: string;
  /** One line for the model: what the area is for. */
  summary: string;
  /** The connection's instructions; given with its tools. */
  guide?: string;
  /** Tools listed in every conversation, whatever was picked (e.g. automation_create). */
  alwaysShown?: string[];
  /**
   * False for areas reached through others (an app group, through app_guide):
   * not an answer to the question of which areas a request needs.
   */
  routed?: boolean;
}

export const TOOL_RUN = "tool_run";
export const TOOLS_OPEN = "tools_open";

/** The area a tool belongs to; undefined for built-in tools, which are always listed. */
export function areaOf(tools: ToolRegistry, tool: Pick<ToolDef, "name" | "onDemand">): string | undefined {
  if (tool.onDemand) return tool.onDemand;
  const connection = tools.sourceOf(tool.name)?.split(":")[0];
  return connection === "core" ? undefined : connection;
}

export function runToolSpec(): ToolSpec {
  return {
    name: TOOL_RUN,
    description: "Run a tool whose definition was given in the conversation but which is not in your tool list, by its exact name, with arguments as its definition says.",
    parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] },
  };
}

export function openToolSpec(areas: readonly ToolArea[]): ToolSpec {
  return {
    name: TOOLS_OPEN,
    description: "Get the tools of an area that are not in your tool list. Then call them through tool_run.",
    parameters: { type: "object", properties: { area: { type: "string", enum: areas.map((a) => a.id) } }, required: ["area"] },
  };
}

/** One line per area, in the system prompt: what can be done, listed or not. */
export function capabilityList(areas: readonly ToolArea[]): string {
  return `Areas of tools. A tool not in your list whose definition is already in the conversation: call it through tool_run. Otherwise call tools_open with its area first.\n${areas.map((a) => `- ${a.id}: ${a.summary}`).join("\n")}`;
}

/** Definitions for tools reached through tool_run, with the area's guide. */
export function definitionsText(area: ToolArea | undefined, specs: readonly ToolSpec[]): string {
  const lines = specs.map((s) => JSON.stringify({ name: s.name, description: s.description, parameters: s.parameters }));
  return [
    `Tools${area ? ` for ${area.id}` : ""}, called through tool_run with {"name": …, "arguments": {…}}:`,
    ...lines,
    ...(area?.guide ? ["", area.guide] : []),
  ].join("\n");
}

/** A tool_run call, read as the call it stands for; null when it isn't one. */
export function unwrapRun(argumentsText: string): { name: string; argumentsText: string } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsText); } catch { return { error: `${TOOL_RUN} needs JSON: {"name": "…", "arguments": {…}}.` }; }
  const p = parsed as { name?: unknown; arguments?: unknown };
  if (typeof p?.name !== "string" || !p.name) return { error: `${TOOL_RUN} needs the tool's exact name.` };
  if (p.name === TOOL_RUN || p.name === TOOLS_OPEN) return { error: `Call ${p.name} directly, not through ${TOOL_RUN}.` };
  const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
  return { name: p.name, argumentsText: args };
}

/** An area passes from this share of the odds; at most this many are picked. */
const PICK_FROM = 0.15;
const PICK_MAX = 3;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The areas a request needs, from the odds of one letter: one prefill, no
 * text. Every area past PICK_FROM counts, so a request that needs mail and
 * the calendar can get both. On 36 synthetic requests in 11 languages it
 * opened every needed area for 34, at ~0.7 s on a 35B model. Null when the
 * model can't tell; then every connection is listed.
 */
export async function pickAreas(model: ChatModel, goal: string, areas: readonly ToolArea[], signal?: AbortSignal): Promise<string[] | null> {
  if (!model.firstTokenOdds || areas.length === 0 || areas.length >= LETTERS.length) return null;
  const options = [{ id: "", summary: "no tools: answering, writing or translating text, maths, explanations" }, ...areas];
  const letters = options.map((_, i) => LETTERS[i]!);
  const odds = await model.firstTokenOdds([
    { role: "system", content: "You decide which tools a Mac assistant needs for a request. Answer with a single letter." },
    { role: "user", content: `Request: ${goal}\n\nAreas:\n${options.map((o, i) => `${letters[i]}) ${o.summary}`).join("\n")}\n\nWhich area does the request need first? Answer with one letter.` },
  ], letters, signal);
  if (!odds) return null;
  const ranked = options.map((o, i) => ({ id: o.id, p: odds[letters[i]!] ?? 0 }));
  const none = ranked[0]!.p;
  const passing = ranked.slice(1).filter((a) => a.p >= PICK_FROM).sort((a, b) => b.p - a.p).slice(0, PICK_MAX);
  if (passing.length === 0 || none > passing[0]!.p) return [];
  return passing.map((a) => a.id);
}
