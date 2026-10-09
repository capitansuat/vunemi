/**
 * What the library keeps of a conversation or a meeting. Pure: the caller
 * reads the files.
 *
 * The one line about each is made without a model, so an item is in the
 * library the moment it exists and costs no model time: a meeting's is the
 * first thing its summary says, a conversation's is what was first asked.
 */
import { maskSecrets, type AgentEvent } from "@vunemi/agent-core";
import { conversationTasks } from "../mentions.js";
import type { Meeting } from "../meetings/store.js";
import type { ItemInput } from "./store.js";

const TITLE_CHARS = 80;
const LINE_CHARS = 140;
/** The words kept to search: enough for a long meeting's summary and the start of what was said. */
const TEXT_CHARS = 40_000;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** FNV-1a: a small number that changes when the text does. */
const hash = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/** A conversation's version: when it was last worked on, and its name, which the user can change without working on it. */
export const conversationStamp = (title: string, updatedAt: number): number => updatedAt * 1000 + (hash(title) % 1000);

/** A conversation with at least one task; null for one with nothing in it. */
export function conversationItem(c: { id: string; title: string; updatedAt: number; events: readonly AgentEvent[] }): ItemInput | null {
  const tasks = conversationTasks(c.events);
  if (tasks.length === 0) return null;
  const asked = c.events.find((e) => e.type === "run.started");
  const first = asked?.type === "run.started" ? asked.goal : "";
  const title = oneLine(c.title || first, TITLE_CHARS);
  // The title is the first request cut short: a line that only repeats it says nothing more.
  const more = tasks.length > 1 ? `${tasks.length} tasks. ` : "";
  const line = oneLine(first, LINE_CHARS) === title || !first ? more.trim() : `${more}${oneLine(first, LINE_CHARS - more.length)}`;
  return { id: c.id, kind: "conversation", title: maskSecrets(title), at: c.updatedAt, line: maskSecrets(line), text: maskSecrets(tasks.join("\n\n").slice(0, TEXT_CHARS)), stamp: conversationStamp(c.title, c.updatedAt) };
}

/** A meeting that is over and has something in it; null while it records or when it is empty. */
export function meetingItem(m: Meeting): ItemInput | null {
  if (m.state === "recording" || m.state === "transcribing" || m.state === "summarising") return null;
  const summary = m.summary?.trim() ?? "";
  if (!summary && m.lines.length === 0) return null;
  const date = new Date(m.startedAt).toISOString().slice(0, 10);
  // The first line under the summary's first heading says what the meeting was; headings and "—" say nothing.
  const said = summary.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^[-=_*—\s]+$/.test(l))
    .map((l) => l.replace(/^[>*\-•\s]+/, "").replace(/\*\*|__|`/g, "").trim()).find((l) => l.length > 0)
    ?? m.lines.slice(0, 3).map((l) => l.text).join(" ");
  const words = m.lines.map((l) => l.text).join("\n");
  return {
    id: m.id, kind: "meeting", title: maskSecrets(oneLine(m.title || `Meeting ${date}`, TITLE_CHARS)), at: m.startedAt,
    line: maskSecrets(oneLine(said, LINE_CHARS)), text: maskSecrets(`${summary}\n\n${words}`.trim().slice(0, TEXT_CHARS)),
    // A meeting has no clock of its own for changes: its name, its state, its summary and how much was said tell when it did.
    stamp: hash(`${m.title}\n${m.state}\n${summary}`) * 1000 + (words.length % 1000),
  };
}
