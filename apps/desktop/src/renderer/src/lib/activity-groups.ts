/**
 * The activity log, one task at a time. A task is everything a single request
 * set off; the log grew to hundreds of rows, and a row is easier to find by the
 * request it belonged to than by scrolling past every step of every task.
 */

import type { ActivityEntry } from "../../../shared/ipc.js";

export interface ActivityTask {
  runId: string;
  goal: string;
  /** Newest entry; the task is listed where this one falls. */
  at: number;
  /** Oldest entry. */
  since: number;
  entries: ActivityEntry[];
  /** Rows that can still be undone. */
  undoable: number;
  /** Rows that failed or were refused. */
  problems: number;
  /** Still running or waiting for the user. */
  active: boolean;
}

/** Keeps the incoming order: lists arrive newest first, and so do the tasks. */
export function groupByTask(entries: readonly ActivityEntry[]): ActivityTask[] {
  const tasks = new Map<string, ActivityTask>();
  for (const entry of entries) {
    let task = tasks.get(entry.runId);
    if (!task) {
      task = { runId: entry.runId, goal: entry.goal, at: entry.at, since: entry.at, entries: [], undoable: 0, problems: 0, active: false };
      tasks.set(entry.runId, task);
    }
    task.entries.push(entry);
    task.at = Math.max(task.at, entry.at);
    task.since = Math.min(task.since, entry.at);
    if (!task.goal && entry.goal) task.goal = entry.goal;
    if (entry.undo && !entry.undone) task.undoable++;
    if (entry.status === "error" || entry.status === "refused") task.problems++;
    if (entry.status === "running" || entry.status === "waiting-user") task.active = true;
  }
  return [...tasks.values()];
}

/** Lower case without accents, and ı as i: "Şubat" is found by "subat". */
function folded(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

/**
 * True when every word of the query appears in the entry: its request, what it
 * did, the tool's name or the label the log shows for it.
 */
export function matchesActivity(entry: ActivityEntry, query: string, label: string): boolean {
  const words = folded(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = folded([entry.goal, entry.preview ?? "", entry.tool, label].join(" "));
  return words.every((word) => text.includes(word));
}
