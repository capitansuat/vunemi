/**
 * After a lookup kept findings in a conversation with no topic: ask once to
 * keep them in a topic. A topic that fits by meaning is asked for as before
 * (suggest.ts); otherwise a new one, under the short name the model gave the
 * search or the request's first words. Nothing is made without the user's yes.
 */
import { safeTitle } from "../work/findings.js";
import { keyOf, type TopicStore } from "./store.js";

/** A new topic's name: at most this many characters, as the model's proposal is. */
const NAME_CHARS = 40;

export function whichAsk(o: {
  inTopic: boolean;
  asked: boolean;
  /** This run's findings, if it kept any. */
  found: readonly { proposedTopic?: string }[] | undefined;
  request: string;
  /** The topic the request fits by meaning, if any. */
  fitting: string | null;
}): { topic: string; new?: true } | null {
  if (o.inTopic || o.asked) return null;
  if (o.fitting) return { topic: o.fitting };
  if (!o.found?.length) return null;
  const proposed = [...o.found].reverse().find((f) => f.proposedTopic?.trim())?.proposedTopic ?? "";
  const topic = safeTitle(proposed, NAME_CHARS) || safeTitle(o.request, NAME_CHARS);
  return topic ? { topic, new: true } : null;
}

/** The user said yes: the topic (made, when new), the conversation in it, and the findings moved there. Returns its name. */
export function acceptAsk(
  held: { topic: string; new?: true },
  /** `move`: the conversation's findings note into the topic (createFindingTools' moveToTopic), where the tool wrote it. */
  d: { topics: TopicStore; request: string; link: (name: string) => void; move?: (name: string) => number },
): string {
  let name: string;
  if (held.new) {
    const existing = d.topics.findTopic(held.topic) ?? d.topics.listTopics().find((x) => keyOf(x.name) === keyOf(held.topic));
    if (existing) name = existing.name;
    else {
      try {
        name = d.topics.createTopic(held.topic, d.request).name;
      } catch {
        const fallback = safeTitle(d.request, NAME_CHARS);
        name = d.topics.findTopic(fallback)?.name ?? d.topics.createTopic(fallback, d.request).name;
      }
    }
  } else {
    const found = d.topics.findTopic(held.topic);
    if (!found) throw new Error(`The topic "${held.topic}" is no longer there.`);
    name = found.name;
  }
  d.link(name);
  d.move?.(name);
  return name;
}
