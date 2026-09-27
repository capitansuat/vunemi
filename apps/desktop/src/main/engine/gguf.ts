import { closeSync, openSync, readSync } from "node:fs";

/**
 * Reads how long a context a GGUF model was trained for, from the file's own
 * header, so the setting can offer every length the model can use and no
 * more. Works offline and for models downloaded before this was kept.
 */

/** The header is read no further than this; the key sits well before it. */
const READ_LIMIT = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/** Byte sizes of GGUF's fixed-width value types, by type number. */
const FIXED: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

class Reader {
  private buf = Buffer.alloc(0);
  private at = 0;
  private fileAt = 0;

  constructor(private readonly fd: number) {}

  private need(n: number): void {
    if (this.buf.length - this.at >= n) return;
    if (this.fileAt + n > READ_LIMIT) throw new Error("GGUF header too long");
    const chunk = Buffer.alloc(Math.max(CHUNK, n));
    const got = readSync(this.fd, chunk, 0, chunk.length, this.fileAt);
    this.fileAt += got;
    this.buf = Buffer.concat([this.buf.subarray(this.at), chunk.subarray(0, got)]);
    this.at = 0;
    if (this.buf.length < n) throw new Error("GGUF file ends early");
  }

  bytes(n: number): Buffer {
    this.need(n);
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }

  u64(): number {
    const n = this.bytes(8).readBigUInt64LE(0);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF value too large");
    return Number(n);
  }

  string(): string {
    return this.bytes(this.u64()).toString("utf8");
  }

  skip(type: number): void {
    if (type === STRING) {
      this.bytes(this.u64());
    } else if (type === ARRAY) {
      const inner = this.u32();
      const count = this.u64();
      if (FIXED[inner] !== undefined) this.bytes(FIXED[inner] * count);
      else for (let i = 0; i < count; i++) this.skip(inner);
    } else if (FIXED[type] !== undefined) {
      this.bytes(FIXED[type]);
    } else {
      throw new Error(`Unknown GGUF type ${type}`);
    }
  }

  /** An integer, or each integer of an array of them; null for anything else. */
  integers(type: number): number[] | null {
    if (type !== ARRAY) {
      const n = this.integer(type);
      return n === null ? null : [n];
    }
    const inner = this.u32();
    const count = this.u64();
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const n = this.integer(inner);
      if (n === null) {
        for (let j = i + 1; j < count; j++) this.skip(inner);
        return null;
      }
      out.push(n);
    }
    return out;
  }

  integer(type: number): number | null {
    switch (type) {
      case 0: return this.bytes(1).readUInt8(0);
      case 2: return this.bytes(2).readUInt16LE(0);
      case 4: return this.u32();
      case 5: return this.bytes(4).readInt32LE(0);
      case 10: return this.u64();
      case 11: return Number(this.bytes(8).readBigInt64LE(0));
      default:
        this.skip(type);
        return null;
    }
  }
}

/** Whether the file starts like a GGUF model. */
export function isGguf(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.toString("latin1") === "GGUF";
  } finally {
    closeSync(fd);
  }
}

/** The model's trained context length, or null when the file does not say. */
export function trainedContext(path: string): number | null {
  return modelShape(path).context;
}

/** What decides how much memory the model's context takes, read from the header. */
export interface ModelShape {
  context: number | null;
  /** Bytes the key/value cache grows by per token, at llama.cpp's default 16-bit cache. */
  kvBytesPerToken: number | null;
}

const SHAPE_KEYS = [
  "context_length", "block_count", "attention.head_count", "attention.head_count_kv",
  "attention.key_length", "attention.value_length", "embedding_length", "full_attention_interval",
] as const;

/**
 * The trained context and the context's memory cost per token. Hybrid models
 * (Qwen3.5/3.6) keep a key/value cache only in every `full_attention_interval`-th
 * layer; the others hold a small fixed state, left out here. A sliding window
 * isn't taken into account, so for such models this errs high.
 */
export function modelShape(path: string): ModelShape {
  const none = { context: null, kvBytesPerToken: null };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return none;
  }
  try {
    const r = new Reader(fd);
    if (r.bytes(4).toString("latin1") !== "GGUF") return none;
    if (r.u32() < 2) return none;
    r.u64(); // tensors
    const keys = r.u64();
    let arch: string | null = null;
    const found: Partial<Record<(typeof SHAPE_KEYS)[number], number[]>> = {};
    for (let i = 0; i < keys; i++) {
      const key = r.string();
      const type = r.u32();
      if (key === "general.architecture" && type === STRING) {
        arch = r.string();
        continue;
      }
      const name = SHAPE_KEYS.find((k) => key.endsWith(`.${k}`) && !key.startsWith("general."));
      if (!name || (arch && !key.startsWith(`${arch}.`))) {
        r.skip(type);
        continue;
      }
      const value = r.integers(type);
      if (value) found[name] = value;
    }
    const one = (k: (typeof SHAPE_KEYS)[number]) => (found[k]?.length === 1 && found[k]![0]! > 0 ? found[k]![0]! : null);
    const context = one("context_length");
    const layers = one("block_count");
    const heads = one("attention.head_count");
    const headDim = heads && one("embedding_length") ? one("embedding_length")! / heads : null;
    const keyLength = one("attention.key_length") ?? headDim;
    const valueLength = one("attention.value_length") ?? headDim;
    const kvHeads = found["attention.head_count_kv"] ?? (heads ? [heads] : null);
    if (!layers || !kvHeads || !keyLength || !valueLength) return { context, kvBytesPerToken: null };
    const interval = one("full_attention_interval") ?? 1;
    let perToken = 0;
    for (let layer = 0; layer < layers; layer++) {
      if ((layer + 1) % interval !== 0) continue;
      const n = kvHeads.length === 1 ? kvHeads[0]! : (kvHeads[layer] ?? 0);
      perToken += n * (keyLength + valueLength) * 2;
    }
    return { context, kvBytesPerToken: perToken > 0 ? perToken : null };
  } catch {
    return none;
  } finally {
    closeSync(fd);
  }
}
