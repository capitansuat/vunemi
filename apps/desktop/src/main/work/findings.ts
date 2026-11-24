/**
 * Web findings: what a lookup found that bears on the request, kept so old
 * pages can leave the model's context without losing it.
 *
 * In a topic, each item (a job, a product) is a page of its own, written as
 * Vunemi's, and the lookup's list page links them; the same item found again
 * updates its page, and a page the user wrote is never written over. With no
 * topic, findings go into the conversation's one findings note, under the
 * request they answer; when it is full the model rewrites it shorter with
 * worknote_write (same title), keeping what matters: nothing is cut from the top.
 *
 * The address is the browser's, never the model's: a finding names the page
 * it came from. Findings are page data, not instructions: they are masked for
 * secrets, and read back fenced like any note.
 */
import { maskSecrets, type ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { TopicStore } from "../topics/store.js";
import { noteScope as noteScopeOf } from "./notes-tools.js";
import { NOTE_LIMITS, type WorkNote, type WorkStore } from "./store.js";

export interface Finding {
  request: string;
  title: string;
  text: string;
  url: string;
  at: number;
}

export interface FindingsWhere {
  conversationId: string;
  projectId?: string;
  conversationTitle?: string;
  topic?: string;
}

export const FINDING_LIMITS = { title: 80, text: 500, topic: 40, request: 80, listRequest: 60 } as const;

/** What topic titles can't hold, replaced by a space: / \ : * ? " < > | [ ] # ^ and control characters. */
export function safeTitle(raw: string, max: number = FINDING_LIMITS.title): string {
  const clean = raw
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|[\]#^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return [...clean].slice(0, max).join("").trim();
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const two = (n: number): string => String(n).padStart(2, "0");
/** The user's own clock and calendar, as they read the note. */
const clock = (at: number): string => { const d = new Date(at); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const day = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

/** A line of the conversation's findings note. */
const noteLine = (f: Finding): string => `- **${oneLine(f.title)}**: ${oneLine(f.text)} — ${f.url} (${clock(f.at)})`;
const LINE = /^- \*\*(.+?)\*\*: (.*) — (\S+) \((\d\d:\d\d)\)$/;

/** The line on a lookup's list page. */
export const listLine = (title: string, url: string): string => `- [[${title}]] — ${url}`;

/** A topic page's text: the finding, then where it came from. */
export const pageText = (f: Finding): string => `${f.text.trim()}\n\nSource: ${f.url} (${day(f.at)})`;

const heading = (request: string): string => `## ${[...oneLine(request)].slice(0, FINDING_LIMITS.request).join("")}`;

/**
 * The note with the finding under its request's heading; the same title and
 * address already there is not added again. `full` when it would pass `limit`.
 */
export function addToNote(note: string | null, f: Finding, limit: number): { text: string; added: boolean } | { full: true } {
  const text = (note ?? "").trim();
  const head = heading(f.request);
  const line = noteLine(f);
  const blocks = text ? text.split(/\n(?=## )/) : [];
  const at = blocks.findIndex((b) => b.split("\n")[0] === head);
  if (at >= 0) {
    const same = blocks[at]!.split("\n").slice(1).some((l) => {
      const m = LINE.exec(l);
      // A list page shows many items of one name at one address: only the same facts are the same item.
      return m !== null && m[1] === oneLine(f.title) && m[3] === f.url && m[2] === oneLine(f.text);
    });
    if (same) return { text, added: false };
    blocks[at] = `${blocks[at]!.trimEnd()}\n${line}`;
  } else {
    blocks.push(`${head}\n${line}`);
  }
  const next = blocks.map((b) => b.trim()).join("\n\n");
  return next.length > limit ? { full: true } : { text: next, added: true };
}

/** The findings in a conversation note, in order. */
function parseNote(text: string, at: number): Finding[] {
  const out: Finding[] = [];
  let request = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      request = line.slice(3).trim();
      continue;
    }
    const m = LINE.exec(line.trim());
    if (m) out.push({ request, title: m[1]!, text: m[2]!, url: m[3]!, at });
  }
  return out;
}

/** The conversation's findings note's title: with the conversation's title in a project, whose notes are shared. */
export function findingsTitle(where: FindingsWhere): string {
  const base = t("findings.noteTitle");
  const named = where.projectId && where.conversationTitle ? `${base} — ${oneLine(where.conversationTitle)}` : base;
  return [...named].slice(0, NOTE_LIMITS.title).join("");
}

/** The lookup's list page in a topic. */
export function listTitle(request: string): string {
  const shortRequest = safeTitle(request, FINDING_LIMITS.listRequest) || "…";
  return safeTitle(t("findings.listTitle", { request: shortRequest }), FINDING_LIMITS.title + FINDING_LIMITS.listRequest).slice(0, 80).trim();
}

const SOURCE_LINE = /\n\nSource: \S+ \(\d{4}-\d\d-\d\d\)$/;
const cutTo = (title: string, room: number): string => [...title].slice(0, FINDING_LIMITS.title - room).join("").trim();

/**
 * Writes the finding's page and its list line in the topic; returns the
 * page's title, and whether a page of the finding's name held another item.
 * A page the user wrote is never written over (the finding goes to "… (web)").
 * A page of this name with other facts is another item, as a list page shows
 * many alike: the finding gets the next free name, "… (2)", and nothing is lost.
 */
function toTopic(topics: TopicStore, topic: string, f: Finding, sources: string[]): { title: string; other: boolean } {
  let base = safeTitle(f.title) || "…";
  const theirs = topics.readNote(topic, base);
  if (theirs && theirs.by === "user") base = safeTitle(`${cutTo(base, 6)} (web)`);
  let title = base;
  for (let n = 2; n <= 100; n++) {
    const at = topics.readNote(topic, title);
    if (!at || (at.by !== "user" && at.text.replace(SOURCE_LINE, "").trim() === f.text.trim())) break;
    title = safeTitle(`${cutTo(base, String(n).length + 3)} (${n})`);
  }
  topics.writeNote(topic, { title, text: pageText(f), by: "vunemi", sources });
  const list = listTitle(f.request);
  const old = topics.readNote(topic, list);
  const has = old?.text.includes(`[[${title}]]`) ?? false;
  if (!has) {
    const next = [old?.text.trim(), listLine(title, f.url)].filter(Boolean).join("\n");
    // A full list page keeps the pages; only the line is left out.
    if (next.length <= 4_000) topics.writeNote(topic, { title: list, text: next, by: old?.by ?? "vunemi", sources });
  }
  return { title, other: title !== base };
}

/**
 * Moves the conversation note's findings into the topic as pages; returns how
 * many. The note is then deleted, unless it holds lines that aren't findings
 * (the model rewrote it in its own words): then it stays, so nothing is lost.
 */
export function moveNoteToTopic(work: WorkStore, topics: TopicStore, where: FindingsWhere, topic: string, now: () => number = Date.now): number {
  const note = work.readNote(noteScopeOf(where), findingsTitle(where));
  if (!note) return 0;
  const items = parseNote(note.text, now());
  for (const f of items) toTopic(topics, topic, f, note.sources);
  const other = note.text.split("\n").some((l) => l.trim() !== "" && !l.startsWith("## ") && !LINE.test(l.trim()));
  if (!other) work.deleteNote(note.id);
  return items.length;
}

export interface FindingToolsOptions {
  work: WorkStore;
  topics: TopicStore | null;
  where: () => FindingsWhere;
  /** The request of the run, word for word. */
  request: (runId: string | undefined) => string;
  /** The browser's current page; null when none is open. */
  page: () => Promise<{ url: string; title: string } | null>;
  /** Where untrusted content this conversation read came from (the Sentinel's list). */
  sources: () => string[];
  /** The Vault's: masks any stored secret. */
  redact: (text: string) => string | Promise<string>;
  onSaved: (saved: { runId?: string; note: WorkNote; scope: "project" | "conversation" }) => void;
  onFinding: (runId: string | undefined, f: Finding & { proposedTopic?: string }) => void;
  now?: () => number;
}

/** The note is full: the model rewrites it shorter under the same title with worknote_write, which replaces a note by title. */
export const findingsFull = (title: string): string => `The findings note is full. Rewrite it shorter with worknote_write under the title "${title}", in the same form, keeping what matters to the request; then add this finding again.`;
export const NO_PAGE = "Open the page this finding comes from, then add it.";

export function createFindingTools(opts: FindingToolsOptions): {
  tools: ToolDef[];
  runFindings: (runId: string) => Finding[];
  /** The open conversation's findings note into the topic, from the same place the tool writes it (see moveNoteToTopic). */
  moveToTopic: (topic: string) => number;
} {
  const now = opts.now ?? Date.now;
  const byRun = new Map<string, Finding[]>();
  const topicOf = (where: FindingsWhere): string | null => (where.topic && opts.topics?.findTopic(where.topic)?.name) || null;
  const mask = async (text: string): Promise<string> => {
    try {
      return maskSecrets(await opts.redact(text));
    } catch {
      throw new Error("The Vault couldn't check this finding for stored secrets, so nothing was saved. Try again in a moment.");
    }
  };
  const tools: ToolDef[] = [
    {
      name: "web_finding_add",
      description: `Keep one item from the open page that matches the request (a job, a product), facts as written; skip others. Address is added. title: the item and who offers it, ≤${FINDING_LIMITS.title}; text ≤${FINDING_LIMITS.text}; topic: short name for the search.`,
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, text: { type: "string" }, topic: { type: "string" } },
        required: ["title", "text"],
        additionalProperties: false,
      },
      // Vunemi's own notes and topic pages, which the user sees and manages: no card for each.
      actionClass: "read",
      saves: true,
      run: async (a, ctx) => {
        const rawTitle = oneLine(String(a.title ?? ""));
        const rawText = String(a.text ?? "").trim();
        if (!rawTitle || [...rawTitle].length > FINDING_LIMITS.title) throw new Error(`A finding needs a title of 1–${FINDING_LIMITS.title} characters.`);
        if (!rawText || rawText.length > FINDING_LIMITS.text) throw new Error(`A finding needs a text of 1–${FINDING_LIMITS.text} characters.`);
        const where = opts.where();
        const page = await opts.page();
        if (!page || !/^https?:\/\//i.test(page.url)) throw new Error(NO_PAGE);
        const f: Finding = { request: opts.request(ctx.runId), title: await mask(rawTitle), text: await mask(rawText), url: page.url, at: now() };
        // Kept whole up to a title's length: the question shortens it at a word (topics/findings-ask.ts).
        const proposed = [...oneLine(String(a.topic ?? ""))].slice(0, FINDING_LIMITS.title).join("");
        const topic = topicOf(where);
        let said: string;
        if (topic && opts.topics) {
          const kept = toTopic(opts.topics, topic, f, opts.sources());
          said = `Kept "${kept.title}" (${f.url}) in the topic "${topic}".`;
          if (kept.other) said += ` A page of that name held another item; to change that one instead, use topic_note_write.`;
        } else {
          const scope = noteScopeOf(where);
          const title = findingsTitle(where);
          const next = addToNote(opts.work.readNote(scope, title)?.text ?? null, f, NOTE_LIMITS.text);
          if ("full" in next) throw new Error(findingsFull(title));
          if (!next.added) return `"${f.title}" from this page is already in the findings.`;
          const { note } = opts.work.writeNote({ scope, conversationId: where.conversationId, title, text: next.text, sources: opts.sources() });
          opts.onSaved({ ...(ctx.runId && { runId: ctx.runId }), note, scope: where.projectId ? "project" : "conversation" });
          said = `Kept "${f.title}" (${f.url}) in this conversation's findings.`;
        }
        if (ctx.runId) byRun.set(ctx.runId, [...(byRun.get(ctx.runId) ?? []), f]);
        opts.onFinding(ctx.runId, { ...f, ...(proposed && { proposedTopic: proposed }) });
        return said;
      },
    },
  ];
  return {
    tools,
    runFindings: (runId) => [...(byRun.get(runId) ?? [])],
    moveToTopic: (topic) => (opts.topics ? moveNoteToTopic(opts.work, opts.topics, opts.where(), topic, now) : 0),
  };
}

export { findingsOption } from "./findings-option.js";
