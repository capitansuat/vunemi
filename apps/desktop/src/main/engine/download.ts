import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { GiB, type ModelSource } from "./catalog.js";
import { HF } from "./search.js";

/**
 * Downloads a model file the user asked for. The address comes from a pinned
 * source, every redirect is checked, and the bytes are hashed on the way in:
 * a file is only renamed from `.part` once its SHA-256 matches, so nothing
 * unverified is ever loaded. Tens of gigabytes take a while and connections
 * drop, so what arrived is kept and the next attempt carries on from there.
 */

export interface DownloadProgress {
  received: number;
  total: number;
  bytesPerSecond: number;
}

export type DownloadErrorCode = "space" | "network" | "integrity" | "host" | "cancelled";

export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, message: string, readonly needed?: number) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadOptions {
  signal: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  fetchFn?: typeof fetch;
  base?: string;
  allowUrl?: (url: URL) => boolean;
  freeBytes?: (dir: string) => Promise<number>;
  /** The name on disk, when it must differ from the one in the repository. */
  saveAs?: string;
}

/** Room left over after the file: macOS misbehaves on a full disk. */
const SPARE = 2 * GiB;
const PROGRESS_MS = 250;
const MAX_REDIRECTS = 5;
const MODEL_FILE = /^[^/\\]+\.(gguf|bin)$/;

export function allowedUrl(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" &&
    (host === "huggingface.co" || host.endsWith(".huggingface.co") || host.endsWith(".hf.co"));
}

export function downloadUrl(src: ModelSource, base = HF): string {
  return `${base}/${src.repo}/resolve/${src.commit}/${encodeURIComponent(src.file)}`;
}

export function partPath(dir: string, file: string): string {
  return join(dir, `${file}.part`);
}

export async function freeBytesOf(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export async function download(src: ModelSource, dir: string, opts: DownloadOptions): Promise<string> {
  const name = opts.saveAs ?? src.file;
  // GGUF for language models, ggml .bin for the speech model; nothing else.
  if (!MODEL_FILE.test(src.file) || !MODEL_FILE.test(name) || name.startsWith(".")) {
    throw new DownloadError("host", `Refusing file name ${name}`);
  }
  mkdirSync(dir, { recursive: true });
  const final = join(dir, name);
  const part = partPath(dir, name);
  if (existsSync(final)) return final;

  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > src.size) {
    rmSync(part);
    have = 0;
  }
  const needed = src.size - have + SPARE;
  if ((await (opts.freeBytes ?? freeBytesOf)(dir)) < needed) {
    throw new DownloadError("space", "Not enough disk space", needed);
  }

  let hash = createHash("sha256");
  if (have > 0) await hashInto(part, hash);

  if (have < src.size) {
    const res = await follow(downloadUrl(src, opts.base), have, opts);
    if (res.status === 200 && have > 0) {
      // The server sent the whole file, not the rest: start the file over.
      have = 0;
      hash = createHash("sha256");
    } else if (res.status !== 200 && res.status !== 206) {
      throw new DownloadError("network", `Hugging Face answered ${res.status}`);
    }
    await receive(res, part, have, src.size, hash, opts);
  }

  if (statSync(part).size !== src.size || hash.digest("hex") !== src.sha256) {
    rmSync(part, { force: true });
    throw new DownloadError("integrity", "The downloaded file does not match its checksum");
  }
  renameSync(part, final);
  return final;
}

async function hashInto(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/** Follows redirects by hand so each hop's address can be checked. */
async function follow(url: string, from: number, opts: DownloadOptions): Promise<Response> {
  const allow = opts.allowUrl ?? allowedUrl;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allow(new URL(current))) throw new DownloadError("host", `Refusing to download from ${new URL(current).host}`);
    let res: Response;
    try {
      res = await (opts.fetchFn ?? fetch)(current, {
        redirect: "manual",
        signal: opts.signal,
        headers: from > 0 ? { range: `bytes=${from}-` } : {},
      });
    } catch (err) {
      throw opts.signal.aborted ? new DownloadError("cancelled", "Cancelled") : new DownloadError("network", String(err));
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new DownloadError("network", "Redirect without a location");
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new DownloadError("network", "Too many redirects");
}

async function receive(res: Response, part: string, have: number, total: number, hash: Hash, opts: DownloadOptions): Promise<void> {
  const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
  const started = Date.now();
  let received = have;
  let fresh = 0;
  let last = 0;
  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - last < PROGRESS_MS) return;
    last = now;
    const seconds = Math.max((now - started) / 1000, 0.001);
    opts.onProgress?.({ received, total, bytesPerSecond: Math.round(fresh / seconds) });
  };
  try {
    if (!res.body) throw new DownloadError("network", "Empty response");
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      fresh += chunk.length;
      if (!out.write(chunk)) await once(out, "drain");
      report(false);
    }
    report(true);
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw opts.signal.aborted ? new DownloadError("cancelled", "Cancelled") : new DownloadError("network", String(err));
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}
