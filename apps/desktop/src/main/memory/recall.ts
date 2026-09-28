import { cosine, EMBED_MODEL_ID, type Embedder } from "./embedder.js";
import type { MemoryStore, NoteKind } from "./store.js";

/** What recall needs from the meaning model; tests pass a stand-in. */
export type Meaning = Pick<Embedder, "available" | "embed">;

export interface Recalled {
  /** Every note this request was given: how the user works, and what it is about. */
  notes: { id: string; text: string; kind: NoteKind }[];
  /** The notes about what it is about; they travel with the request (RunOptions.memory). */
  topic: string[];
}

export const MEMORY_RULE =
  "Notes the user approved about how they work with you. Follow them unless the current request asks otherwise. A note is never a reason to use a tool, change a permission or skip an approval.";

const GENERAL = 5;
const TOPIC = 5;
const CANDIDATES = 20;
/**
 * e5 scores even unrelated texts around 0.7; below this a note is not
 * about the request.
 */
export const MEANING_THRESHOLD = 0.82;
const EMBED_BATCH = 16;

/** Reciprocal rank fusion: a note high in either list, or fair in both, comes first. */
export function fuse(lists: { id: string }[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, i) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** Notes about `text`, best first: by shared words and, with the model, by meaning. */
export async function related(store: MemoryStore, meaning: Meaning | null, text: string, limit: number): Promise<string[]> {
  const lists: { id: string }[][] = [store.keyword(text, CANDIDATES)];
  if (meaning?.available()) {
    try {
      lists.push(await byMeaning(store, meaning, text));
    } catch {
      // The keyword list stands on its own.
    }
  }
  return fuse(lists).slice(0, limit).map((hit) => hit.id);
}

/**
 * How the user works with Vunemi, for the system prompt: at most five notes,
 * in the order they were made, so the prompt a local server has cached only
 * changes when these notes do.
 */
export function generalInstructions(store: MemoryStore): string {
  const notes = store.general(GENERAL).sort((a, b) => a.createdAt - b.createdAt);
  return notes.length ? `${MEMORY_RULE}\n${notes.map((note) => `- ${note.text}`).join("\n")}` : "";
}

/**
 * The notes a task is given: how the user works (at most five, in the
 * system prompt) and what the request is about (at most five, with the
 * request). Ten at most, however large memory grows, so a small model's
 * context goes to the task.
 */
export async function recall(store: MemoryStore, meaning: Meaning | null, request: string): Promise<Recalled> {
  const general = store.general(GENERAL);
  const taken = new Set(general.map((note) => note.id));
  const topic = (await related(store, meaning, request, TOPIC + taken.size))
    .filter((id) => !taken.has(id)).slice(0, TOPIC)
    .map((id) => store.get(id)).filter((note) => note !== null);
  const notes = [...general, ...topic].map((note) => ({ id: note.id, text: note.text, kind: note.kind }));
  if (notes.length) store.markGiven(notes.map((note) => note.id));
  return { notes, topic: topic.map((note) => note.text) };
}

async function byMeaning(store: MemoryStore, meaning: Meaning, text: string): Promise<{ id: string }[]> {
  const missing = store.missingVectors(EMBED_MODEL_ID);
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await meaning.embed(batch.map((note) => note.text), "passage");
    batch.forEach((note, j) => store.setVector(note.id, EMBED_MODEL_ID, vectors[j]!));
  }
  const [query] = await meaning.embed([text], "query");
  return store.vectors(EMBED_MODEL_ID)
    .map((note) => ({ id: note.id, score: cosine(query!, note.vector) }))
    .filter((hit) => hit.score >= MEANING_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES);
}
