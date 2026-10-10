/**
 * What "@" brings into a request: which conversations and meetings can be
 * picked, what is read from one, and how several share the room they get.
 *
 * From a conversation only what was asked and what was answered: tool
 * output is the bulk of a conversation and the part least worth carrying.
 * From a meeting the summary always, and the words when there is room.
 *
 * Pure: the caller reads the files.
 */
import type { AgentEvent, MentionRef } from "@vunemi/agent-core";
import { isLocale, tIn } from "@vunemi/i18n";
import type { MentionItem, SessionSummary } from "../shared/ipc.js";
import { MEETING_ID, type Meeting, type MeetingSummary } from "./meetings/store.js";
import { lineLabel, type Names } from "./meetings/summary.js";
import { SESSION_ID } from "./sessions.js";

export const MAX_MENTIONS = 5;
/** All the mentions of one message together get this share of the context window. */
export const MENTION_SHARE = 0.4;
const TITLE_CHARS = 80;

/** Only our two kinds and ids of our own shape: the window is not trusted to send more. */
export function mentionRefs(value: unknown): MentionRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) throw new Error("Bad mention");
  return value.map((entry: unknown) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const { kind, id, title } = r;
    if (typeof id !== "string" || typeof title !== "string") throw new Error("Bad mention");
    if (kind === "conversation" ? !SESSION_ID.test(id) : kind === "meeting" ? !MEETING_ID.test(id) : true) throw new Error("Bad mention");
    return { kind: kind as MentionRef["kind"], id, title: title.slice(0, TITLE_CHARS) };
  });
}

/** Newest first. Not the open conversation, one with nothing in it, or a meeting still recording. */
export function mentionable(sessions: readonly SessionSummary[], meetings: readonly MeetingSummary[], currentId: string): MentionItem[] {
  return [
    ...sessions.filter((s) => s.id !== currentId && s.runs > 0).map((s) => ({ kind: "conversation" as const, id: s.id, title: s.title, at: s.updatedAt })),
    ...meetings.filter((m) => m.state !== "recording").map((m) => ({ kind: "meeting" as const, id: m.id, title: m.title, at: m.startedAt })),
  ].sort((a, b) => b.at - a.at);
}

/** One text per task: the request, the questions answered on the way, the final answer. */
export function conversationTasks(events: readonly AgentEvent[]): string[] {
  const tasks: string[] = [];
  const questions = new Map<string, string>();
  let lines: string[] | null = null;
  let answer = "";
  let answerStep = "";
  const flush = (): void => {
    if (!lines) return;
    if (answer.trim()) lines.push(`Vunemi: ${answer.trim()}`);
    tasks.push(lines.join("\n"));
  };
  for (const e of events) {
    if (e.type === "run.started") {
      flush();
      lines = [`User: ${e.goal}`];
      answer = "";
      answerStep = "";
    } else if (!lines) {
      continue;
    } else if (e.type === "message.delta") {
      // The last step that said something is the answer; earlier ones narrate.
      if (e.stepId !== answerStep) answer = "";
      answerStep = e.stepId;
      answer += e.text;
    } else if (e.type === "choice.asked" && e.card.kind === "choice") {
      questions.set(e.callId, e.card.question);
    } else if (e.type === "choice.answered") {
      const question = questions.get(e.callId);
      if (question) lines.push(`Vunemi asked: ${question}`);
      lines.push(`User chose: ${e.text}`);
    }
  }
  flush();
  return tasks;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number): string => String(n).padStart(2, "0");
  const rest = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${rest}` : rest;
}

export function meetingParts(meeting: Pick<Meeting, "summary" | "lines"> & Partial<Pick<Meeting, "speakers" | "language">>): { summary: string; transcript: string } {
  // The others told apart are called what the summary calls them: the user's names, or their number in the meeting's language.
  const language = isLocale(meeting.language) ? meeting.language : "en";
  const names: Names = { me: "Me", others: "Others", person: (n) => tIn(language, "meetings.person", { n }) };
  return {
    summary: meeting.summary?.trim() ? `Summary:\n${meeting.summary.trim()}` : "No summary was written.",
    transcript: meeting.lines.map((l) => `[${clock(l.start)}] ${lineLabel(l, names, meeting.speakers)}: ${l.text}`).join("\n"),
  };
}

/** What was read from a mention; null when it no longer exists. */
export type MentionSource =
  | { kind: "conversation"; tasks: string[] }
  | { kind: "meeting"; summary: string; transcript: string }
  | null;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

/** The newest tasks that fit `share`. The newest always stays, cut if it must be. */
function fitTasks(tasks: readonly string[], share: number): string {
  const whole = tasks.join("\n\n");
  if (whole.length <= share) return whole;
  for (let from = 1; from < tasks.length; from++) {
    const note = from === 1 ? "The earliest task is left out: too long." : `The ${from} earliest tasks are left out: too long.`;
    const text = `${note}\n\n${tasks.slice(from).join("\n\n")}`;
    if (text.length <= share || from === tasks.length - 1) return clip(text, share);
  }
  return clip(whole, share);
}

/**
 * The text each mention gets, within `total` characters between them.
 * Conversations and meeting summaries come first; when they do not fit, the
 * conversations share what the summaries leave. Transcripts then take what
 * is left, in the order mentioned, each whole or not at all.
 */
export function mentionTexts(sources: readonly MentionSource[], total: number): (string | null)[] {
  let fixed = 0;
  let wanted = 0;
  let conversations = 0;
  for (const s of sources) {
    if (s?.kind === "meeting") fixed += s.summary.length;
    if (s?.kind === "conversation") {
      wanted += s.tasks.join("\n\n").length;
      conversations++;
    }
  }
  const share = fixed + wanted <= total ? Infinity : Math.max(0, Math.floor((total - fixed) / Math.max(1, conversations)));
  const first = sources.map((s) => (s === null ? null : s.kind === "conversation" ? fitTasks(s.tasks, share) : s.summary));
  let left = total - first.reduce((n, text) => n + (text?.length ?? 0), 0);
  return sources.map((s, i) => {
    if (s?.kind !== "meeting" || !s.transcript) return first[i]!;
    if (s.transcript.length > left) return `${s.summary}\n\nThe transcript is left out: too long.`;
    left -= s.transcript.length;
    return `${s.summary}\n\nTranscript:\n${s.transcript}`;
  });
}
