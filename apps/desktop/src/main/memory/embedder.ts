import { existsSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine/engine.js";
import type { ModelSource } from "../engine/catalog.js";
import { download, type DownloadProgress } from "../engine/download.js";
import type { MemorySearchStatus } from "../../shared/ipc.js";

/**
 * The model that finds notes by meaning: Qwen3-Embedding-0.6B (Apache-2.0,
 * over 100 languages), 8-bit, in Qwen's own conversion; the built-in
 * llama.cpp serves it. Measured on 20 notes and 24 indirect Turkish and
 * English requests (28 Sep), it found three times as many of the right
 * notes as multilingual-e5-small.
 */
export const EMBED_MODEL: ModelSource = {
  repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
  commit: "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
  file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  size: 639_150_592,
  sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
};

export const EMBED_MODEL_ID = "qwen3-embedding-0.6b-q8_0";

/** Qwen3-Embedding is told what a query is for; notes go in as they are. */
const QUERY_TASK = "Given a request to an assistant, retrieve notes about the user that help with it";

export type EmbedderStatus = MemorySearchStatus;

export interface EmbedderOptions {
  /** The llama-server binary; null when this build has none. */
  binary: string | null;
  /** Where the model is kept. */
  dir: string;
  pidFile?: string;
  idleMs?: number;
  onChange?: (status: EmbedderStatus) => void;
  /** Replaced in tests. */
  download?: typeof download;
}

/** Notes and cut requests fit easily; a sequence must fit in one batch. */
const CONTEXT = 512;
/** Long requests are cut: the start says what they are about, and it must fit. */
const MAX_QUERY_CHARS = 400;
const IDLE_MS = 5 * 60_000;
const REQUEST_MS = 30_000;

export class Embedder {
  private readonly engine: Engine;
  private readonly path: string;
  private downloading: { controller: AbortController; progress: DownloadProgress | null; done: Promise<string> } | null = null;

  constructor(private readonly opts: EmbedderOptions) {
    this.path = join(opts.dir, EMBED_MODEL.file);
    this.engine = new Engine({
      binary: opts.binary,
      // Nothing keeps it loaded: a search is over in a moment.
      isBusy: () => false,
      idleMs: opts.idleMs ?? IDLE_MS,
      ...(opts.pidFile && { pidFile: opts.pidFile }),
    });
  }

  available(): boolean {
    return !!this.opts.binary && existsSync(this.path);
  }

  status(): EmbedderStatus {
    if (!this.opts.binary) return { state: "unavailable" };
    if (existsSync(this.path)) return { state: "ready", bytes: EMBED_MODEL.size };
    if (this.downloading) return { state: "downloading", bytes: EMBED_MODEL.size, received: this.downloading.progress?.received ?? 0 };
    return { state: "absent", bytes: EMBED_MODEL.size };
  }

  /** The pinned file, checked by SHA-256, only when the user presses the button. */
  async download(): Promise<EmbedderStatus> {
    if (!this.opts.binary) return this.status();
    if (!this.downloading) {
      const controller = new AbortController();
      const state: NonNullable<Embedder["downloading"]> = { controller, progress: null, done: Promise.resolve("") };
      this.downloading = state;
      state.done = (this.opts.download ?? download)(EMBED_MODEL, this.opts.dir, {
        signal: controller.signal,
        onProgress: (p) => {
          state.progress = p;
          this.opts.onChange?.(this.status());
        },
      });
      this.opts.onChange?.(this.status());
    }
    const running = this.downloading;
    try {
      await running.done;
    } finally {
      if (this.downloading === running) this.downloading = null;
      this.opts.onChange?.(this.status());
    }
    return this.status();
  }

  cancelDownload(): void {
    this.downloading?.controller.abort();
  }

  /** One unit-length vector per text; a query carries its task, as the model was trained. */
  async embed(texts: string[], as: "query" | "passage"): Promise<Float32Array[]> {
    if (!this.available()) throw new Error("The meaning model is not downloaded.");
    if (texts.length === 0) return [];
    // The last token (llama.cpp appends <|endoftext|>) stands for the text.
    const endpoint = await this.engine.ensure({ id: EMBED_MODEL_ID, path: this.path, context: CONTEXT, pooling: "last" });
    const input = texts.map((text) => (as === "query" ? `Instruct: ${QUERY_TASK}\nQuery: ${text.slice(0, MAX_QUERY_CHARS)}` : text));
    const res = await fetch(`${endpoint.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL_ID, input }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!res.ok) throw new Error(`The meaning model answered ${res.status}.`);
    this.engine.touch();
    const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const vectors: Float32Array[] = [];
    for (const item of body.data ?? []) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || !Array.isArray(item.embedding)) continue;
      vectors[item.index] = normalise(Float32Array.from(item.embedding));
    }
    if (vectors.length !== texts.length || vectors.some((v) => !v)) throw new Error("The meaning model gave an incomplete answer.");
    return vectors;
  }

  stop(): Promise<void> {
    this.cancelDownload();
    return this.engine.stop();
  }
}

/** For unit-length vectors, the dot product; 0 when they can't be compared. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const length = Math.sqrt(sum);
  if (!length) return v;
  return v.map((x) => x / length);
}
