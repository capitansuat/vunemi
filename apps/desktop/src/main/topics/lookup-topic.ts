/**
 * A web lookup in a conversation with no topic gathers in a temporary topic,
 * made by Vunemi: the answer the user saw, with the addresses the run read,
 * as a page, and the findings the model kept. The user keeps or deletes it
 * (the card after the lookup, or the Memory page); nothing removes it by itself.
 *
 * Addresses are the browser's own page lines, never the model's words; the
 * answer is masked for the Vault's secrets like any finding.
 */
import { maskSecrets } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { FINDING_LIMITS, safeTitle } from "../work/findings.js";
import { shortName } from "./findings-ask.js";
import { TOPIC_LIMITS, type TopicStore } from "./store.js";

/** A page view's own line: "[tab 1] Title — https://…", or after "Now on: ". The first one is the page's; text below it is the page's content. */
const PAGE_LINE = /^(?:Now on: )?\[tab \d+\] .* — (https?:\/\/\S+)/m;

/** The address in a page view's output; null for other tools' replies. */
export function pageAddress(output: string): string | null {
  return PAGE_LINE.exec(output)?.[1] ?? null;
}

/** The answer, then its sources; a long answer is cut at a line, the sources kept. */
export function answerPageText(answer: string, addresses: readonly string[], max: number): string {
  const text = answer.trim();
  const sources = addresses.length ? `\n\n${t("findings.sources")}:\n${addresses.map((a) => `- ${a}`).join("\n")}` : "";
  if (text.length + sources.length <= max) return text + sources;
  const room = max - sources.length - "\n…".length;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const next = length + (kept.length ? 1 : 0) + line.length;
    if (next > room) break;
    kept.push(line);
    length = next;
  }
  return `${kept.join("\n").trimEnd()}\n…${sources}`.slice(0, max);
}

/**
 * The topic this lookup gathers in: the conversation's own, when it has one;
 * none when the user deleted its temporary topic here; else a new temporary
 * one, linked to the conversation, under the model's name for the search or
 * the request's first words ("… (2)" when the name is taken).
 */
export function temporaryTopic(d: {
  topics: TopicStore;
  conversation: { topic?: string; declined: boolean };
  proposed: string;
  request: string;
  link: (name: string) => void;
}): string | null {
  const own = d.conversation.topic ? d.topics.findTopic(d.conversation.topic) : null;
  if (own) return own.name;
  if (d.conversation.declined) return null;
  const base = shortName(d.proposed) || shortName(d.request);
  if (!base) return null;
  const name = d.topics.createTopic(d.topics.freeTopicName(base), d.request, { temporary: true }).name;
  d.link(name);
  return name;
}

/** The answer page's title: the request cut at a word, to fit beside the catalogue's words. */
function answerTitle(request: string): string {
  const around = [...t("findings.answerTitle", { request: "" })].length;
  const shortRequest = shortName(request, Math.min(FINDING_LIMITS.listRequest, FINDING_LIMITS.title - around)) || "…";
  return safeTitle(t("findings.answerTitle", { request: shortRequest }), FINDING_LIMITS.title);
}

/**
 * Writes the lookup's answer as Vunemi's page in the topic; returns its title,
 * or null when there is no answer. Another answer to the same request gets
 * the next free name, "… (2)"; the same answer again is the same page, and a
 * page the user wrote is never written over.
 */
export async function writeAnswer(d: {
  topics: TopicStore;
  topic: string;
  request: string;
  answer: string;
  addresses: readonly string[];
  redact: (s: string) => string | Promise<string>;
}): Promise<string | null> {
  if (!d.answer.trim()) return null;
  const answer = maskSecrets(await d.redact(d.answer.trim()));
  const text = answerPageText(answer, d.addresses, TOPIC_LIMITS.text);
  const base = answerTitle(d.request);
  let title = base;
  for (let n = 2; n <= 100; n++) {
    const at = d.topics.readNote(d.topic, title);
    if (!at || (at.by !== "user" && at.text.trim() === text.trim())) break;
    title = `${[...base].slice(0, FINDING_LIMITS.title - String(n).length - 3).join("").trim()} (${n})`;
  }
  d.topics.writeNote(d.topic, { title, text, by: "vunemi", sources: [] });
  return title;
}
