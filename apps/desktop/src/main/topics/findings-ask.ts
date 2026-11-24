/**
 * The questions under a run about topics. A conversation with no topic is
 * asked once whether it belongs in a topic that fits by meaning (suggest.ts).
 * A web lookup gathers in a temporary topic (lookup-topic.ts), and its card
 * asks to keep it, under a name the user can change, or delete it.
 */
import { safeTitle } from "../work/findings.js";
import type { TopicStore } from "./store.js";

/** A new topic's name: at most this many characters, as the model's proposal is. */
const NAME_CHARS = 40;

/** Asked after a finished task, and after one that ran out of steps only when it kept findings. */
export function asksAfter(status: "done" | "max_steps", found: readonly unknown[] | undefined): boolean {
  return status === "done" || (found?.length ?? 0) > 0;
}

/** A name for the card: cleaned for a folder, cut at a word, with no bracket left open or dangling mark. */
export function shortName(raw: string, max: number = NAME_CHARS): string {
  const clean = safeTitle(raw, Number.MAX_SAFE_INTEGER);
  const chars = [...clean];
  if (chars.length <= max) return clean;
  let cut = chars.slice(0, max).join("");
  if (/[\p{L}\p{N}]/u.test(chars[max]!) && cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
  const open = cut.lastIndexOf("(");
  if (open > 0 && cut.indexOf(")", open) < 0) cut = cut.slice(0, open);
  return cut.replace(/[\s,;:.\-–—(]+$/u, "").trim();
}

/** Asked after a run in a conversation with no topic, when a topic the user has fits what was asked. A lookup gathers in a temporary topic instead (lookup-topic.ts). */
export function whichAsk(o: {
  inTopic: boolean;
  asked: boolean;
  request: string;
  /** The topic the request fits by meaning, if any. */
  fitting: string | null;
}): { topic: string } | null {
  if (o.inTopic || o.asked || !o.fitting) return null;
  return { topic: o.fitting };
}

/** The topics another conversation may be offered by meaning: never a temporary one, until the user keeps it. */
export function suggestable<T extends { temporary?: true }>(topics: readonly T[]): T[] {
  return topics.filter((x) => !x.temporary);
}

/** The user said yes to a fitting topic: the conversation in it, and its findings note moved there. Returns its name. */
export function acceptAsk(
  held: { topic: string },
  /** `move`: the conversation's findings note into the topic (createFindingTools' moveToTopic), where the tool wrote it. */
  d: { topics: TopicStore; request: string; link: (name: string) => void; move?: (name: string) => number },
): string {
  const found = d.topics.findTopic(held.topic);
  if (!found) throw new Error(`The topic "${held.topic}" is no longer there.`);
  d.link(found.name);
  d.move?.(found.name);
  return found.name;
}

/**
 * Keep, on the temporary topic's card: the mark goes, under the name typed
 * when it changed (conversations in it follow). A taken or bad name throws and
 * changes nothing; the card stays open. Returns the topic's name.
 */
export function keepAsk(held: { topic: string }, d: { topics: TopicStore; name?: string; rename: (from: string, to: string) => void }): string {
  const was = d.topics.findTopic(held.topic);
  if (!was) throw new Error(`The topic "${held.topic}" is no longer there.`);
  const kept = d.topics.keepTopic(was.name, d.name);
  if (kept.name !== was.name) d.rename(was.name, kept.name);
  return kept.name;
}

/** Delete, on the card: the folder goes to the Trash, and this conversation makes no temporary topic again. */
export async function deleteAsk(held: { topic: string }, d: { trash: (topic: string) => Promise<void>; decline: () => void }): Promise<void> {
  await d.trash(held.topic);
  d.decline();
}
