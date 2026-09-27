import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelShape, trainedContext } from "../../src/main/engine/gguf.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenami-gguf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);

/** A GGUF header with the given key/value pairs (already encoded as type + value). */
function gguf(kvs: [string, Buffer][]): string {
  const path = join(dir, "m.gguf");
  writeFileSync(path, Buffer.concat([
    Buffer.from("GGUF"), u32(3), u64(0), u64(kvs.length),
    ...kvs.flatMap(([k, v]) => [str(k), v]),
  ]));
  return path;
}

describe("the trained context length", () => {
  it("is read past strings and arrays that come before it", () => {
    const path = gguf([
      ["general.name", Buffer.concat([u32(8), str("Tiny")])],
      ["tokenizer.ggml.tokens", Buffer.concat([u32(9), u32(8), u64(2), str("a"), str("bc")])],
      ["tokenizer.ggml.scores", Buffer.concat([u32(9), u32(6), u64(3), Buffer.alloc(12)])],
      ["qwen35moe.context_length", Buffer.concat([u32(4), u32(262_144)])],
    ]);
    expect(trainedContext(path)).toBe(262_144);
  });

  it("accepts a 64-bit value", () => {
    expect(trainedContext(gguf([["llama.context_length", Buffer.concat([u32(10), u64(131_072)])]]))).toBe(131_072);
  });

  it("is unknown when the file does not say, is not GGUF, or ends early", () => {
    expect(trainedContext(gguf([["general.name", Buffer.concat([u32(8), str("Tiny")])]]))).toBeNull();
    const other = join(dir, "x.gguf");
    writeFileSync(other, "not a model");
    expect(trainedContext(other)).toBeNull();
    writeFileSync(other, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(5)]));
    expect(trainedContext(other)).toBeNull();
    expect(trainedContext(join(dir, "missing.gguf"))).toBeNull();
  });
});

describe("the context's memory per token", () => {
  const int = (n: number) => Buffer.concat([u32(4), u32(n)]);

  it("counts only the attention layers of a hybrid model", () => {
    // The shape of Qwen3.6-35B-A3B: 40 layers, every 4th with attention, 2 KV heads of 256.
    const path = gguf([
      ["general.architecture", Buffer.concat([u32(8), str("qwen35moe")])],
      ["qwen35moe.block_count", int(40)],
      ["qwen35moe.context_length", int(262_144)],
      ["qwen35moe.attention.head_count", int(16)],
      ["qwen35moe.attention.head_count_kv", int(2)],
      ["qwen35moe.attention.key_length", int(256)],
      ["qwen35moe.attention.value_length", int(256)],
      ["qwen35moe.full_attention_interval", int(4)],
    ]);
    expect(modelShape(path)).toEqual({ context: 262_144, kvBytesPerToken: 10 * 2 * 512 * 2 });
  });

  it("derives the head size and reads per-layer KV heads", () => {
    const path = gguf([
      ["general.architecture", Buffer.concat([u32(8), str("llama")])],
      ["llama.block_count", int(2)],
      ["llama.embedding_length", int(4096)],
      ["llama.attention.head_count", int(32)],
      ["llama.attention.head_count_kv", Buffer.concat([u32(9), u32(4), u64(2), u32(8), u32(4)])],
    ]);
    expect(modelShape(path).kvBytesPerToken).toBe((8 + 4) * (128 + 128) * 2);
  });

  it("is unknown when the file lacks the shape", () => {
    expect(modelShape(gguf([["llama.context_length", int(4096)]]))).toEqual({ context: 4096, kvBytesPerToken: null });
  });
});
