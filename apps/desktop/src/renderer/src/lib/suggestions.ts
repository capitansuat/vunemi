import type { MessageKey } from "@vunemi/i18n";

/**
 * What the empty chat offers. Goals are tasks with details the user will want
 * to change, so they go into the composer to be edited; ideas are read-only
 * checks, sent as they are. Each needs a connection, and is offered only
 * when that connection is ready: a suggestion that can only fail teaches the
 * user nothing.
 */
export interface Suggestion {
  key: MessageKey;
  /** The connection it needs, by id; none for what works without one. */
  needs?: string;
}

export const GOALS: readonly Suggestion[] = [
  { key: "app.goals.calendar", needs: "calendar" },
  { key: "app.goals.week", needs: "calendar" },
  { key: "app.goals.files", needs: "files" },
  { key: "app.goals.research", needs: "browser" },
];

export const IDEAS: readonly Suggestion[] = [
  { key: "app.ideas.mail", needs: "mail" },
  { key: "app.ideas.awaiting", needs: "mail" },
  { key: "app.ideas.today", needs: "calendar" },
  { key: "app.ideas.reminders", needs: "reminders" },
  { key: "app.ideas.help" },
];

/** In a project: its folder is where the work goes. */
export const PROJECT_GOALS: readonly Suggestion[] = [
  { key: "app.goals.projectWebsite", needs: "files" },
  { key: "app.goals.projectDocument", needs: "files" },
  { key: "app.goals.projectChange", needs: "files" },
];

export const PROJECT_IDEAS: readonly Suggestion[] = [
  { key: "app.ideas.projectOverview", needs: "files" },
  { key: "app.ideas.help" },
];

const MAX_SHOWN = 4;

/** The ones whose connection is ready, at most four. Until the list is known, only those needing nothing. */
export function available(all: readonly Suggestion[], ready: ReadonlySet<string> | null): Suggestion[] {
  return all.filter((item) => !item.needs || (ready?.has(item.needs) ?? false)).slice(0, MAX_SHOWN);
}

/**
 * What a new user can switch on, shown on the empty chat while it is off.
 * Every connection starts off, and a first screen that offered only "what
 * can you do?" left people with nothing to try.
 */
export const DISCOVER: readonly { id: string; key: MessageKey }[] = [
  { id: "calendar", key: "app.discover.calendar" },
  { id: "mail", key: "app.discover.mail" },
  { id: "files", key: "app.discover.files" },
  { id: "browser", key: "app.discover.browser" },
  { id: "reminders", key: "app.discover.reminders" },
];

const MAX_DISCOVER = 3;

/** The ones still off, at most three. Nothing until the list is known. */
export function switchable(ready: ReadonlySet<string> | null): { id: string; key: MessageKey }[] {
  if (ready === null) return [];
  return DISCOVER.filter((item) => !ready.has(item.id)).slice(0, MAX_DISCOVER);
}
