import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { download, DownloadError, type DownloadProgress } from "../../src/main/engine/download.js";

const BYTES = randomBytes(100_000);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const source = { repo: "org/m", commit: "c".repeat(40), file: "m-Q4_K_M.gguf", size: BYTES.length, sha256: SHA };

let dir: string;
let server: Server;
let base: string;
let ranges: (string | undefined)[];
let honourRange: boolean;
let slow: boolean;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-dl-"));
  ranges = [];
  honourRange = true;
  slow = false;
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const from = honourRange && req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)![1]) : 0;
    res.writeHead(from > 0 ? 206 : 200, { "content-length": String(BYTES.length - from) });
    if (!slow) return res.end(BYTES.subarray(from));
    res.write(BYTES.subarray(from, from + 10_000)); // then stall
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = (over: object = {}) => ({
  signal: new AbortController().signal,
  base,
  allowUrl: () => true,
  freeBytes: async () => 1e12,
  ...over,
});

describe("downloading under another name", () => {
  it("saves and resumes under the name it is given", async () => {
    writeFileSync(join(dir, "mine.mmproj.gguf.part"), BYTES.subarray(0, 30_000));
    const path = await download(source, dir, opts({ saveAs: "mine.mmproj.gguf" }));
    expect(path).toBe(join(dir, "mine.mmproj.gguf"));
    expect(readFileSync(path)).toEqual(BYTES);
    expect(ranges).toEqual(["bytes=30000-"]);
    expect(existsSync(join(dir, source.file))).toBe(false);
  });

  it("refuses a name that is a path", async () => {
    await expect(download(source, dir, opts({ saveAs: "../x.gguf" }))).rejects.toBeInstanceOf(DownloadError);
  });
});

describe("downloading a model", () => {
  it("fetches the pinned file and checks it", async () => {
    const progress: DownloadProgress[] = [];
    const path = await download(source, dir, opts({ onProgress: (p: DownloadProgress) => progress.push(p) }));
    expect(path).toBe(join(dir, source.file));
    expect(readFileSync(path).equals(BYTES)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(progress.at(-1)).toMatchObject({ received: BYTES.length, total: BYTES.length });
  });

  it("carries on from where it stopped", async () => {
    writeFileSync(join(dir, `${source.file}.part`), BYTES.subarray(0, 40_000));
    const path = await download(source, dir, opts());
    expect(ranges).toEqual(["bytes=40000-"]);
    expect(readFileSync(path).equals(BYTES)).toBe(true);
  });

  it("starts over when the server ignores the range", async () => {
    honourRange = false;
    writeFileSync(join(dir, `${source.file}.part`), BYTES.subarray(0, 40_000));
    const path = await download(source, dir, opts());
    expect(readFileSync(path).equals(BYTES)).toBe(true);
  });

  it("throws the file away when the checksum is wrong", async () => {
    const err = await download({ ...source, sha256: "0".repeat(64) }, dir, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe("integrity");
    expect(existsSync(join(dir, `${source.file}.part`))).toBe(false);
  });

  it("does not start without room for the file", async () => {
    const err = await download(source, dir, opts({ freeBytes: async () => 10 })).catch((e: unknown) => e);
    expect((err as DownloadError).code).toBe("space");
    expect((err as DownloadError).needed).toBeGreaterThan(BYTES.length);
    expect(ranges).toEqual([]);
  });

  it("keeps what arrived when cancelled", async () => {
    slow = true;
    const ctrl = new AbortController();
    const running = download(source, dir, opts({
      signal: ctrl.signal,
      onProgress: (p: DownloadProgress) => { if (p.received > 0) ctrl.abort(); },
    }));
    const err = await running.catch((e: unknown) => e);
    expect((err as DownloadError).code).toBe("cancelled");
    expect(statSync(join(dir, `${source.file}.part`)).size).toBeGreaterThan(0);
  });

  it("refuses to be sent anywhere but Hugging Face", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/m.gguf" } }));
    const err = await download(source, dir, { signal: new AbortController().signal, fetchFn: fetchFn as unknown as typeof fetch, freeBytes: async () => 1e12 }).catch((e: unknown) => e);
    expect((err as DownloadError).code).toBe("host");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(`https://huggingface.co/org/m/resolve/${"c".repeat(40)}/m-Q4_K_M.gguf`);
  });
});
