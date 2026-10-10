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
  if (m.state === "recording" || m.state === "transcribing" || m.state === "separating" || m.state === "summarising") return null;
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

/** As much of an item as a line shows of where it says something: a sentence or two. */
const SAID_CHARS = 160;
/** As the store compares words: without accents or case. */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Where an item's words say what a request asks about: the stretch with
 * the most of the request's words that its name and line do not show.
 * A conversation is named by what was first asked, and what the user wants
 * back is often said further in. Null when the name and line show them all
 * already, or when none is there (it was found by meaning). `stems` are
 * what the request's telling words begin with (LibraryStore.tellingStems).
 */
export function whereSaid(item: { title: string; line: string; text: string }, stems: readonly string[]): string | null {
  const shown = fold(`${item.title} ${item.line}`).match(/[\p{L}\p{N}]+/gu) ?? [];
  const wanted = stems.map(fold).filter((stem) => !shown.some((word) => word.startsWith(stem)));
  if (wanted.length === 0) return null;
  const hits: { at: number; stem: string }[] = [];
  for (const word of item.text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const folded = fold(word[0]);
    const stem = wanted.find((s) => folded.startsWith(s));
    if (stem) hits.push({ at: word.index, stem });
  }
  let best: { at: number; stems: number } | null = null;
  for (const hit of hits) {
    const within = new Set(hits.filter((other) => other.at >= hit.at && other.at < hit.at + SAID_CHARS).map((other) => other.stem)).size;
    if (!best || within > best.stems) best = { at: hit.at, stems: within };
  }
  if (!best) return null;
  // From the start of its sentence when that is near, so it reads as said.
  const before = item.text.slice(Math.max(0, best.at - 60), best.at);
  const start = [...before.matchAll(/[.!?]\s+|\n+/g)].at(-1) ?? (best.at <= 60 ? { index: 0, 0: "" } : undefined);
  const from = start ? best.at - before.length + start.index + start[0].length : best.at;
  return `${start ? "" : "…"}${oneLine(item.text.slice(from, from + SAID_CHARS * 2), SAID_CHARS)}`;
}
