import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serverArgs } from "../../src/main/engine/engine.js";
import { cosine, EMBED_MODEL, Embedder } from "../../src/main/memory/embedder.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
let dir = "";
let embedders: Embedder[] = [];

beforeAll(() => chmodSync(FAKE, 0o755));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-embed-")); });
afterEach(async () => {
  await Promise.all(embedders.map((e) => e.stop()));
  embedders = [];
  rmSync(dir, { recursive: true, force: true });
});

function make(opts: Partial<ConstructorParameters<typeof Embedder>[0]> = {}): Embedder {
  const embedder = new Embedder({ binary: FAKE, dir, ...opts });
  embedders.push(embedder);
  return embedder;
}

const withModel = () => writeFileSync(join(dir, EMBED_MODEL.file), "gguf");

describe("the meaning model", () => {
  it("is pinned: multilingual-e5-small, 131.6 MB, by commit and SHA-256", () => {
    expect(EMBED_MODEL).toEqual({
      repo: "cstr/multilingual-e5-small-GGUF",
      commit: "178420da727e544c2689e89b6648b205ad176eda",
      file: "multilingual-e5-small-q8_0.gguf",
      size: 131_624_960,
      sha256: "0a34067a40f25d3149b36885faa62bee0e5284d0f9edc102acfc00e115d953e8",
    });
  });

  it("runs llama-server as an embedding server on this Mac only", () => {
    expect(serverArgs({ id: "e", path: "/m/e.gguf", context: 512, embedding: true }, 5555, "k")).toEqual([
      "-m", "/m/e.gguf", "--host", "127.0.0.1", "--port", "5555", "--api-key", "k",
      "--embedding", "--pooling", "mean", "-c", "512", "-b", "512", "-ub", "512", "-np", "1", "-ngl", "999", "--no-webui",
    ]);
  });

  it("says what is missing", () => {
    expect(make({ binary: null }).status()).toMatchObject({ state: "unavailable" });
    const embedder = make();
    expect(embedder.status()).toEqual({ state: "absent", bytes: EMBED_MODEL.size });
    expect(embedder.available()).toBe(false);
    withModel();
    expect(embedder.status()).toMatchObject({ state: "ready" });
    expect(embedder.available()).toBe(true);
  });

  it("embeds queries and notes with the prefixes e5 expects, normalised, in order", async () => {
    withModel();
    const [query] = await make().embed(["rapor"], "query");
    expect([...query!].map((x) => +x.toFixed(3))).toEqual([0.6, 0, 0.8]);
    const [a, b] = await embedders[0]!.embed(["a", "b"], "passage");
    expect([...a!].map((x) => +x.toFixed(3))).toEqual([0, 0.6, 0.8]);
    expect(b).toEqual(a);
  });

  it("refuses to embed without the model", async () => {
    await expect(make().embed(["x"], "query")).rejects.toThrow();
  });

  it("downloads only the pinned file, into its own folder", async () => {
    const calls: { file: string; dir: string }[] = [];
    const embedder = make({
      download: async (src, into) => {
        calls.push({ file: src.file, dir: into });
        writeFileSync(join(into, src.file), "gguf");
        return join(into, src.file);
      },
    });
    expect(await embedder.download()).toMatchObject({ state: "ready" });
    expect(calls).toEqual([{ file: EMBED_MODEL.file, dir }]);
  });
});

describe("cosine", () => {
  it("compares directions", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1]))).toBe(0);
  });
});
