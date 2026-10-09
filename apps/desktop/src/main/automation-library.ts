/**
 * The automation library: the tasks Vunemi offers to schedule (recipes), and
 * what the user is shown before one is set up.
 *
 * A recipe is a task in plain words with a scope: the parts of connections
 * its runs may use ("calendar:read", "apps:notes"). A run gets the tools of
 * those parts and no others, and like every scheduled run none that send,
 * delete or pay (see runAgent). So what a scheduled task can do is decided
 * here, in code, and the lines of the summary are made from the same scope:
 * they stay true whatever a model says about the task.
 */
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { RecipeView } from "../shared/ipc.js";
import { describeSchedule, validSchedule, type Schedule } from "./automations.js";

export type RecipeCategory = "morning" | "work" | "files";

export interface Recipe {
  id: string;
  /** Its line in the gallery is automations.recipe.<key>.body. */
  key: "morning" | "awaiting" | "today" | "nextWeek" | "mailNotes" | "downloads";
  /** Where its title and task are; the first two were offered before there was a library. */
  texts: `automations.suggest.${"morning" | "awaiting"}` | `automations.recipe.${"today" | "nextWeek" | "mailNotes" | "downloads"}`;
  category: RecipeCategory;
  scope: readonly string[];
  /** When it runs unless the user says otherwise. */
  schedule: Schedule;
}

export const RECIPES: readonly Recipe[] = [
  { id: "morning-brief", key: "morning", texts: "automations.suggest.morning", category: "morning", scope: ["calendar:read", "mail:read"], schedule: { kind: "daily", time: "08:00" } },
  { id: "awaiting-reply", key: "awaiting", texts: "automations.suggest.awaiting", category: "morning", scope: ["mail:read"], schedule: { kind: "daily", time: "08:30" } },
  { id: "today-plan", key: "today", texts: "automations.recipe.today", category: "morning", scope: ["calendar:read", "reminders:read"], schedule: { kind: "daily", time: "07:30" } },
  { id: "next-week", key: "nextWeek", texts: "automations.recipe.nextWeek", category: "work", scope: ["calendar:read"], schedule: { kind: "daily", time: "16:00", days: [5] } },
  { id: "mail-to-notes", key: "mailNotes", texts: "automations.recipe.mailNotes", category: "work", scope: ["mail:read", "apps:notes"], schedule: { kind: "daily", time: "18:00", days: [1, 2, 3, 4, 5] } },
  { id: "sort-downloads", key: "downloads", texts: "automations.recipe.downloads", category: "files", scope: ["files:read", "files:write"], schedule: { kind: "daily", time: "19:00" } },
];

/** The task a recipe sets up, in the user's language; the window names a recipe, it can't supply a task. */
export function recipeTask(id: string): { title: string; task: string; schedule: Schedule; scope: string[] } {
  const recipe = RECIPES.find((r) => r.id === id);
  if (!recipe) throw new Error(t("automations.suggest.unknown"));
  return { title: t(`${recipe.texts}.title`), task: t(`${recipe.texts}.task`), schedule: recipe.schedule, scope: [...recipe.scope] };
}

/**
 * A recipe's schedule with the user's own time and days. The kind stays the
 * recipe's: the window chooses when, not what.
 */
export function recipeSchedule(recipe: Recipe, blanks: unknown): Schedule {
  const b = (blanks ?? {}) as { time?: unknown; days?: unknown };
  if (recipe.schedule.kind !== "daily" || (b.time === undefined && b.days === undefined)) return recipe.schedule;
  return validSchedule({ kind: "daily", time: b.time ?? recipe.schedule.time, days: b.days ?? recipe.schedule.days });
}

/** One part of a connection, as the app knows it now. */
export interface ScopePart {
  /** "Calendar", in the user's language. */
  connection: string;
  /** Whether a scheduled run would get a tool of it that reads, and one that changes something. */
  reads: boolean;
  changes: boolean;
  /** Switched on by the user. */
  on: boolean;
}

/**
 * Parts no scheduled task may have, whatever their tools are: acting on
 * websites and on the screen reaches anything, a shortcut can do anything,
 * and a scheduled task does not schedule.
 */
const NEVER_IN_SCOPE = ["browser:act", "desktop:act", "shortcuts", "automations"];

export interface ScopeSummary {
  /** Connections it reads, and those it can change; one name each, in the scope's order. */
  reads: string[];
  changes: string[];
  /** Connections of its scope that are switched off: it can be set up, and says so. */
  off: string[];
  /** Why it can't be set up, in the user's language; null when it can. */
  refused: string | null;
}

/** What a scope lets a scheduled task do, for the summary the user approves. */
export function summarizeScope(scope: readonly string[], look: (source: string) => ScopePart | null): ScopeSummary {
  const out: ScopeSummary = { reads: [], changes: [], off: [], refused: null };
  const add = (list: string[], name: string): void => void (list.includes(name) || list.push(name));
  for (const source of scope) {
    const part = look(source);
    if (!part) return { ...out, refused: t("automations.summary.unknown", { source }) };
    if (NEVER_IN_SCOPE.some((never) => source === never || source.startsWith(`${never}:`)) || (!part.reads && !part.changes)) {
      return { ...out, refused: t("automations.summary.notAllowed", { name: part.connection }) };
    }
    if (part.reads) add(out.reads, part.connection);
    if (part.changes) add(out.changes, part.connection);
    if (!part.on) add(out.off, part.connection);
  }
  return out;
}

export interface SummaryLine {
  /** True for what it does, false for what it never does. */
  does: boolean;
  text: string;
}

/** The lines of the summary: what it reads, what it can change, and what no scheduled task does. */
export function summaryLines(summary: ScopeSummary): SummaryLine[] {
  const list = (names: string[]): string => names.join(", ");
  return [
    ...(summary.reads.length > 0 ? [{ does: true, text: t("automations.summary.reads", { what: list(summary.reads) }) }] : []),
    ...(summary.changes.length > 0 ? [{ does: true, text: t("automations.summary.changes", { what: list(summary.changes) }) }] : []),
    { does: true, text: t("automations.summary.notifies") },
    { does: false, text: t("automations.summary.never") },
  ];
}

/** What the app knows of its connections and tools, as far as a scope needs. */
export interface ScopeWorld {
  connector(id: string): { label: string; capabilities?: readonly { id: string; label: string; tools: readonly string[] }[] } | undefined;
  isOn(id: string): boolean;
  isPartOn(id: string, part: string): boolean;
  tool(name: string): Pick<ToolDef, "actionClass" | "saves"> | undefined;
}

/** Connections whose parts are different apps: the summary names the app ("Notes"), not the connection. */
const NAMED_BY_PART = ["apps"];

/** Describes a scope's parts from the connections and tools the app has now. */
export function scopeLookup(world: ScopeWorld): (source: string) => ScopePart | null {
  return (source) => {
    const [id, partId] = source.split(":") as [string, string | undefined];
    const connector = world.connector(id);
    const parts = (connector?.capabilities ?? []).filter((part) => partId === undefined || part.id === partId);
    if (!connector || parts.length === 0) return null;
    const tools = parts.flatMap((part) => part.tools.flatMap((name) => world.tool(name) ?? []));
    return {
      connection: partId !== undefined && NAMED_BY_PART.includes(id) ? parts[0]!.label : connector.label,
      reads: tools.some((tool) => tool.actionClass === "read" && !tool.saves),
      // Sending, deleting and paying are not counted: a scheduled run never gets those tools.
      changes: tools.some((tool) => tool.actionClass === "write-local" || (tool.actionClass === "read" && tool.saves === true)),
      on: world.isOn(id) && parts.every((part) => world.isPartOn(id, part.id)),
    };
  };
}

/** The recipes as the gallery shows them, in the user's language. */
export function recipeViews(look: (source: string) => ScopePart | null): RecipeView[] {
  return RECIPES.map((recipe) => {
    const summary = summarizeScope(recipe.scope, look);
    return {
      id: recipe.id, category: recipe.category, title: t(`${recipe.texts}.title`), body: t(`automations.recipe.${recipe.key}.body`),
      when: describeSchedule(recipe.schedule),
      time: recipe.schedule.kind === "daily" ? recipe.schedule.time : null,
      days: recipe.schedule.kind === "daily" ? (recipe.schedule.days ?? null) : null,
      lines: summaryLines(summary), off: summary.off.map((name) => t("automations.summary.off", { name })), refused: summary.refused,
    };
  });
}
