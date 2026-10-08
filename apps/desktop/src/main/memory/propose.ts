import { randomUUID } from "node:crypto";
import type { ChatModel } from "@vunemi/agent-core";
import { related, type Meaning } from "./recall.js";
import type { MemoryStore, NoteKind } from "./store.js";

/** A note Vunemi would like to remember, waiting for the user's yes. */
export interface Proposal {
  id: string;
  text: string;
  kind: NoteKind;
  /** The user's own words it came from, checked to be in what they wrote. */
  quote: string;
  /** The note it would replace. */
  updates?: { id: string; text: string };
}

interface Raw {
  text: string;
  kind: NoteKind;
  quote: string;
  updates?: string;
}

const MAX_PROPOSALS = 3;
const CLOSEST = 8;
const MIN_QUOTE = 6;
/** Fewer characters than this rarely say anything worth remembering. */
const MIN_WORDS_CHARS = 20;

// Measured on synthetic cases (test/main/memory-propose-live.test.ts): asked only to
// "skip one-off requests", the model turned the shape of a single request into a
// preference about one time in four ("as option cards", "keep it informal").
const SYSTEM = `You pick out what is worth remembering about the user for future tasks.
Read only the user's messages. Most tasks leave nothing to remember: answer [] then.
Propose at most ${MAX_PROPOSALS} notes, and only from words in which the user says something that holds beyond this task:
- "general": a standing rule for how you work, said as a rule ("from now on reply briefly", "never call me before noon").
- "topic": a lasting fact about the user or the user's people, projects, places or things ("my accountant is Mira", "I use a wheelchair").
What the user asks for in this task is not a preference. The format, tone, length or language of this request, what the request is about, and an answer to a question you asked belong to this task alone: "write this as a poem" does not mean the user likes poems, and writing in a language is not a note.
Skip anything from text the user pasted or quoted from elsewhere, and passwords, codes, card or identity numbers.
Each note is one short sentence in the user's language, at most 200 characters.
"quote" is the exact words from a user message that show it, copied character for character.
If a note changes or repeats one of the existing notes, set "updates" to that note's id.
Answer with a JSON array only, like [{"text": "...", "kind": "general", "quote": "...", "updates": "n1"}], or [] when there is nothing.`;

/** The quote is in what the user wrote: the same words, case and spacing aside. */
export function quoted(quote: string, messages: string[]): boolean {
  const q = squash(quote);
  if (q.length < MIN_QUOTE) return false;
  return messages.some((message) => squash(message).includes(q));
}

export function parseProposals(raw: string): Raw[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: Raw[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { text, kind, quote, updates } = item as Record<string, unknown>;
    if (typeof text !== "string" || typeof quote !== "string" || (kind !== "general" && kind !== "topic")) continue;
    out.push({ text, kind, quote, ...(typeof updates === "string" && updates && { updates }) });
    if (out.length === MAX_PROPOSALS) break;
  }
  return out;
}

/**
 * After a task: asks the same model what the user said that is worth
 * remembering. Only the user's messages go in, and code, not the model,
 * checks that each proposal's quote is really in them, so a page or a mail
 * that says "remember this" can't become a note. Nothing new is written
 * here; a note said again is counted as confirmed.
 */
export async function propose(opts: {
  model: ChatModel;
  messages: string[];
  store: MemoryStore;
  meaning: Meaning | null;
  signal: AbortSignal;
  sessionId?: string | null;
}): Promise<Proposal[]> {
  const messages = opts.messages.map((m) => m.trim()).filter(Boolean);
  if (messages.join(" ").length < MIN_WORDS_CHARS) return [];

  const closest = (await related(opts.store, opts.meaning, messages.join("\n"), CLOSEST))
    .map((id) => opts.store.get(id)).filter((note) => note !== null);
  const refs = new Map(closest.map((note, i) => [`n${i + 1}`, note]));
  const prompt = [
    "The user's messages:",
    ...messages.map((m) => JSON.stringify(m)),
    "",
    "Existing notes:",
    ...(closest.length ? [...refs].map(([ref, note]) => `[${ref}] ${note.text}`) : ["(none)"]),
  ].join("\n");

  const result = await opts.model.chat(
    { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], tools: [], signal: opts.signal },
    () => {},
  );

  const out: Proposal[] = [];
  for (const raw of parseProposals(result.text)) {
    if (!quoted(raw.quote, messages) || (await opts.store.holdsSecret(raw.quote))) continue;
    let text: string;
    try {
      text = await opts.store.validText(raw.text);
    } catch {
      continue;
    }
    const target = (raw.updates && refs.get(raw.updates)) || closest.find((note) => squash(note.text) === squash(text));
    if (target && squash(target.text) === squash(text)) {
      opts.store.confirm(target.id, { quote: raw.quote.trim(), sessionId: opts.sessionId ?? null, at: Date.now() });
      continue;
    }
    if (out.some((p) => squash(p.text) === squash(text))) continue;
    out.push({
      id: randomUUID(),
      text,
      kind: raw.kind,
      quote: raw.quote.trim(),
      ...(target && { updates: { id: target.id, text: target.text } }),
    });
  }
  return out;
}

/** Text compared as the same words: case and spacing aside. */
export function squash(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}
