/**
 * Which topic a request belongs to, by meaning: the request against each
 * topic's name and what it is about (topic.md), with the memory embedder.
 * Decided here, not by the chat model, so the question doesn't depend on
 * which model the user runs. Without the embedder nothing is suggested;
 * "@" still links a conversation by hand.
 */
import { cosine } from "../memory/embedder.js";
import type { Meaning } from "../memory/recall.js";

/*
 * The best topic must reach this score and stand above the next one by the
 * margin. Chosen on 4 topics, 6 requests that fit one and 4 that fit none,
 * Turkish and English (21 Nov, Qwen3-Embedding-0.6B, topics-live.test.ts):
 * fitting requests scored 0.43–0.50, at least 0.12 ahead of the next topic;
 * the others at most 0.34, at most 0.05 ahead. A miss costs nothing (the
 * user can pick the topic with "@"); a wrong ask costs one card.
 */
export const SUGGEST_MIN = 0.38;
export const SUGGEST_MARGIN = 0.08;
/*
 * The best topic must also stand nearer than this, which stands for requests
 * on no subject. With one topic there is no runner-up for the margin, and a
 * short topic text drew requests that fit nothing: a jobs lookup scored 0.43
 * against a lone topic whose text was its name (24 Nov). Measured as above
 * on the same 4 topics: 5 of the 6 fitting requests stay nearer their topic
 * (by 0.07–0.24); the 4 that fit none, two web lookups and that lone-topic
 * case are all nearer this (by 0.05–0.23). One fitting request is no longer
 * asked about: a miss, which costs nothing.
 */
export const ELSEWHERE = "General\nEveryday requests on no particular subject: the web, email, files, the calendar, quick questions.";
const ABOUT_CHARS = 1_500;
const TASK = "Given a request to an assistant, retrieve the description of the subject the request belongs to";

/** What a topic is compared by: its name, and the paragraph saying what it is about. */
export const topicText = (topic: { name: string; about: string }): string => `${topic.name}\n${topic.about.trim().slice(0, ABOUT_CHARS)}`.trim();

/**
 * The topic the request fits, or null. `cache` keeps each topic's vector by
 * its text, so an unchanged topic.md is embedded once.
 */
export async function suggestTopic(
  meaning: Meaning,
  request: string,
  topics: readonly { name: string; about: string }[],
  cache: Map<string, Float32Array>,
): Promise<string | null> {
  if (!meaning.available() || topics.length === 0 || !request.trim()) return null;
  const texts = topics.map(topicText);
  const missing = [...new Set([...texts, ELSEWHERE].filter((text) => !cache.has(text)))];
  if (missing.length > 0) {
    const vectors = await meaning.embed(missing, "passage");
    missing.forEach((text, i) => cache.set(text, vectors[i]!));
  }
  const [query] = await meaning.embed([request], "query", TASK);
  const scored = topics.map((topic, i) => ({ name: topic.name, score: cosine(query!, cache.get(texts[i]!)!) })).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < SUGGEST_MIN) return null;
  if (next && best.score - next.score < SUGGEST_MARGIN) return null;
  if (best.score <= cosine(query!, cache.get(ELSEWHERE)!)) return null;
  return best.name;
}
