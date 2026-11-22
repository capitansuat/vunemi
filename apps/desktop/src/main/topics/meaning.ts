/**
 * Search by meaning in a topic's notes and sources: each is cut in parts
 * (store.ts partsOf), and each part gets a vector from the memory embedder
 * when Vunemi is idle (catchUp). A search finds by words and by the vectors
 * there are, fused; parts still waiting are found by words meanwhile.
 * Without the embedder, search is by words alone.
 */
import { EMBED_MODEL_ID, TooLongError } from "../memory/embedder.js";
import { fuse, type Meaning } from "../memory/recall.js";
import type { TopicHit, TopicStore } from "./store.js";

const EMBED_BATCH = 16;
/** A part still too long when cut to this is left to words alone: something else is wrong. */
const SHORTEST_CUT = 100;
/** A search embeds this many waiting parts itself first: a source just added is found at once. */
const SEARCH_EMBEDS = 64;
const CANDIDATES = 20;
/*
 * Below this a part is not about the query at all. Measured 21 Nov with
 * Qwen3-Embedding-0.6B (topics-live.test.ts): the part that answers scored
 * 0.34–0.50, but an unrelated Turkish question still reached 0.40 against a
 * Turkish offer, and a poem request stayed under 0.20. Scores of related and
 * unrelated parts overlap, so meaning gives candidates, ranked, for the
 * model to read; only what is plainly off is left out.
 */
export const PART_MIN = 0.25;
const QUERY_TASK = "Given a question, retrieve passages from the user's notes and documents that answer it";

export interface TopicFound {
  hits: TopicHit[];
  /** Parts not yet searchable by meaning, in what was searched. */
  pending: number;
  /** Whether meaning took part at all. */
  byMeaning: boolean;
}

/** How a catch-up pass ended: nothing left, stepped aside for other work, or a request failed. */
export type CatchUp = "done" | "paused" | "failed";

/** Minutes before trying again after `failures` failed passes in a row: 1, 2, 4 … at most 30. */
export function retryAfter(failures: number): number {
  return Math.min(30, 2 ** Math.max(0, failures - 1)) * 60_000;
}

export class TopicMeaning {
  private catching: Promise<CatchUp> | null = null;

  constructor(
    private readonly store: TopicStore,
    private readonly meaning: Meaning,
    private readonly model = EMBED_MODEL_ID,
  ) {}

  /**
   * Makes the missing vectors, a batch at a time, for as long as `goOn`
   * says. Call it when nothing else runs, and again after it stepped aside
   * ("paused") or failed: a failed request ends the pass.
   */
  catchUp(goOn: () => boolean = () => true): Promise<CatchUp> {
    if (!this.meaning.available()) return Promise.resolve("done");
    this.catching ??= (async (): Promise<CatchUp> => {
      this.store.refresh();
      for (;;) {
        if (!goOn()) return "paused";
        if ((await this.embedSome(EMBED_BATCH)) === 0) return "done";
      }
    })()
      .catch((error: unknown): CatchUp => {
        // Said, so a pass that keeps failing can be told apart from one that waits.
        console.error("[vunemi] topic meaning search:", error instanceof Error ? error.message : String(error));
        return "failed";
      })
      .finally(() => (this.catching = null));
    return this.catching;
  }

  /** Embeds up to `limit` waiting parts; how many it did. */
  private async embedSome(limit: number): Promise<number> {
    const batch = this.store.missingParts(this.model, limit);
    if (batch.length === 0) return 0;
    const texts = batch.map(passage);
    let vectors: Float32Array[];
    try {
      vectors = await this.meaning.embed(texts, "passage");
    } catch (error) {
      // One part too long fails the whole batch, and the batch would come back every time.
      if (!(error instanceof TooLongError)) throw error;
      vectors = [];
      for (const text of texts) vectors.push(await this.fitted(text));
    }
    batch.forEach((part, i) => this.store.setPartVector(part.id, part.text, this.model, vectors[i]!));
    return batch.length;
  }

  /** The vector of the text, or of its start when the whole doesn't fit: the start still says what it is about. */
  private async fitted(text: string): Promise<Float32Array> {
    for (let cut = text; ; cut = cut.slice(0, Math.floor(cut.length * 0.75))) {
      try {
        return (await this.meaning.embed([cut], "passage"))[0]!;
      } catch (error) {
        if (!(error instanceof TooLongError) || cut.length <= SHORTEST_CUT) throw error;
      }
    }
  }

  /** Best first: found by words, by meaning, or both. */
  async find(query: string, topic: string | undefined, limit: number): Promise<TopicFound> {
    if (!this.meaning.available() || !query.trim()) return { hits: this.store.search(query, topic, limit), pending: 0, byMeaning: false };
    // Beside meaning, only what holds most of the words: a shared "için" alone isn't a match.
    const byWords = this.store.search(query, topic, CANDIDATES, true);
    try {
      // A few waiting parts are embedded now, the rest when Vunemi is idle.
      for (let done = 0; done < SEARCH_EMBEDS; ) {
        const did = await this.embedSome(Math.min(EMBED_BATCH, SEARCH_EMBEDS - done));
        if (did === 0) break;
        done += did;
      }
      const [vector] = await this.meaning.embed([query], "query", QUERY_TASK);
      const near = this.store.nearestParts(vector!, this.model, topic, CANDIDATES).filter((hit) => hit.score >= PART_MIN);
      const all = new Map<string, TopicHit>();
      // By meaning the part itself is shown: it says more than a few words around a match.
      for (const hit of near) all.set(hit.path, { kind: hit.kind, topic: hit.topic, title: hit.title, snippet: hit.snippet, path: hit.path, ...(hit.at !== undefined && { at: hit.at }) });
      for (const hit of byWords) if (!all.has(hit.path)) all.set(hit.path, hit);
      const ranked = fuse([byWords.map((h) => ({ id: h.path })), near.map((h) => ({ id: h.path }))]);
      return { hits: ranked.slice(0, limit).map((r) => all.get(r.id)!), pending: this.store.pendingParts(this.model, topic), byMeaning: true };
    } catch {
      // The words stand on their own.
      return { hits: this.store.search(query, topic, limit), pending: 0, byMeaning: false };
    }
  }
}

const passage = (part: { title: string; text: string }): string => `${part.title}\n${part.text}`;
