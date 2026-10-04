import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiB } from "../../src/main/engine/catalog.js";
import { EngineService } from "../../src/main/engine/service.js";
import type { FitRequest } from "../../src/main/models/manager.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
const BYTES = randomBytes(50_000);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const COMMIT = "d".repeat(40);
const PROJ = randomBytes(20_000);
const PROJ_SHA = createHash("sha256").update(PROJ).digest("hex");
/** What the fake hub serves: whether the repository has a vision part, and whether its bytes are right. */
let hub: { projector: boolean; badProjector: boolean; revisions: number };

let dir: string;
let server: Server;
let base: string;
let service: EngineService;

beforeEach(async () => {
  chmodSync(FAKE, 0o755);
  dir = mkdtempSync(join(tmpdir(), "vunemi-svc-"));
  hub = { projector: false, badProjector: false, revisions: 0 };
  server = createServer((req, res) => {
    const siblings = () => [
      { rfilename: "tiny-Q4_K_M.gguf", size: BYTES.length, lfs: { sha256: SHA } },
      ...(hub.projector ? [{ rfilename: "mmproj-F16.gguf", size: PROJ.length, lfs: { sha256: PROJ_SHA } }] : []),
    ];
    if (req.url?.startsWith("/api/models/org/tiny-GGUF?blobs=true")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sha: COMMIT, gated: false, cardData: { license: "mit" }, siblings: siblings() }));
    }
    if (req.url === `/api/models/org/tiny-GGUF/revision/${COMMIT}?blobs=true`) {
      hub.revisions++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sha: COMMIT, siblings: siblings() }));
    }
    if (req.url === `/org/tiny-GGUF/resolve/${COMMIT}/tiny-Q4_K_M.gguf`) return res.writeHead(200).end(BYTES);
    if (req.url === `/org/tiny-GGUF/resolve/${COMMIT}/mmproj-F16.gguf`) {
      return res.writeHead(200).end(hub.badProjector ? randomBytes(PROJ.length) : PROJ);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await service?.dispose();
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function argsOf(endpoint: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const res = await fetch(`${endpoint.baseUrl.replace(/\/v1$/, "")}/args`, { headers: { authorization: `Bearer ${endpoint.apiKey}` } });
  return (await res.json()) as string[];
}

function make(testModel = vi.fn(async () => true)) {
  service = new EngineService({
    dir, binary: FAKE, totalMemory: 64 * GiB, isBusy: () => false, testModel, onChange: () => {},
    hub: { base }, allowUrl: () => true, freeBytes: async () => 1e12,
  });
  return { service, testModel };
}

describe("the engine service", () => {
  it("recommends for this Mac and offers every smaller one", () => {
    const { service } = make();
    const view = service.view();
    expect(view.available).toBe(true);
    expect(view.recommended.id).toBe("qwen3.6-35b-a3b-ud-q4_k_xl");
    expect(view.choices.map((c) => c.id)).toEqual([
      "qwen3.6-35b-a3b-ud-q4_k_xl", "qwen3.6-35b-a3b-ud-q3_k_xl", "qwen3.5-9b-ud-q4_k_xl", "gemma-4-e2b-it-q4_0", "qwen3.5-4b-ud-q4_k_xl",
    ]);
    expect(view.installed).toEqual([]);
  });

  it("downloads a searched model, re-reading it from the hub, then tries its tools", async () => {
    const { service, testModel } = make();
    const spec = await service.download({ repo: "org/tiny-GGUF" });
    expect(spec).toBe("vunemi:tiny-q4_k_m");
    expect(testModel).toHaveBeenCalledWith("vunemi:tiny-q4_k_m", expect.objectContaining({ apiKey: expect.any(String) }));
    expect(service.view().installed).toEqual([
      { id: "tiny-q4_k_m", name: "tiny-Q4_K_M", size: BYTES.length, license: "mit", context: 65_536, maxContext: 65_536, vision: "no", weights: BYTES.length, toolTest: "ok" },
    ]);
    expect(service.view().download).toBeNull();
    expect(service.specs()).toEqual(["vunemi:tiny-q4_k_m"]);
  });

  it("tries the tools again when the first answer misses, and fails only after that", async () => {
    const answers = [false, true];
    const { service, testModel } = make(vi.fn(async () => answers.shift() ?? false));
    await service.download({ repo: "org/tiny-GGUF" });
    expect(testModel).toHaveBeenCalledTimes(2);
    expect(service.view().installed[0]?.toolTest).toBe("ok");
    await service.remove("tiny-q4_k_m");

    const never = vi.fn(async () => false);
    const { service: other } = make(never);
    await other.download({ repo: "org/tiny-GGUF" });
    expect(never).toHaveBeenCalledTimes(3);
    expect(other.view().installed[0]?.toolTest).toBe("failed");
  });

  it("keeps the answer of a test run later from Settings", async () => {
    const { service } = make(vi.fn(async () => false));
    await service.download({ repo: "org/tiny-GGUF" });
    service.recordToolTest("vunemi:tiny-q4_k_m", true);
    expect(service.view().installed[0]?.toolTest).toBe("ok");
    service.recordToolTest("lmstudio:x", false); // not ours
    service.recordToolTest("vunemi:gone", false);
    expect(service.view().installed[0]?.toolTest).toBe("ok");
  });

  it("opens the model with the context the manager fits, and reuses it while it is loaded", async () => {
    const fit = vi.fn(async (_req: FitRequest) => ({ context: 8_192, tight: true }));
    service = new EngineService({
      dir, binary: FAKE, totalMemory: 64 * GiB, isBusy: () => false, testModel: vi.fn(async () => true), onChange: () => {},
      hub: { base }, allowUrl: () => true, freeBytes: async () => 1e12, manager: { fit },
    });
    const spec = (await service.download({ repo: "org/tiny-GGUF" }))!;
    await service.unload();
    expect(service.pid()).toBeNull();
    expect(service.mapped()).toBe(0);
    fit.mockClear();

    expect(await service.prepare(spec)).toEqual({ context: 8_192, wanted: 65_536, tight: true, launched: true });
    expect(fit).toHaveBeenCalledTimes(1);
    expect(fit.mock.calls[0]![0]).toMatchObject({ wanted: 65_536 });
    expect(fit.mock.calls[0]![0].replacing).toBeUndefined();
    // The file says nothing about its KV cache: a fifth of the file, whatever the context.
    expect(fit.mock.calls[0]![0].need(65_536)).toBe(fit.mock.calls[0]![0].need(8_192));
    const args = await argsOf(service.endpoint(spec)!);
    expect(args[args.indexOf("-c") + 1]).toBe("8192");
    expect(service.pid()).toEqual(expect.any(Number));
    expect(service.mapped()).toBe(50_000);

    // Loaded with a shorter context: used as it is, not reloaded.
    expect(await service.prepare(spec)).toEqual({ context: 8_192, wanted: 65_536, tight: true, launched: false });
    expect(fit).toHaveBeenCalledTimes(1);

    // A new length from the user is a new launch, which replaces the loaded model.
    await service.setContext("tiny-q4_k_m", 16_384);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit.mock.calls[1]![0]).toMatchObject({ wanted: 16_384, replacing: "chat" });
  });

  it("loads the model again with the context length the user picks", async () => {
    const { service } = make();
    const spec = (await service.download({ repo: "org/tiny-GGUF" }))!;
    await service.prepare(spec);
    const before = service.endpoint(spec)!;
    await service.setContext("tiny-q4_k_m", 16_384);
    expect(service.view().installed[0]?.context).toBe(16_384);
    const after = service.endpoint(spec)!;
    expect(after.baseUrl).not.toBe(before.baseUrl);
    const args = (await (await fetch(`${after.baseUrl.replace(/\/v1$/, "")}/args`, { headers: { authorization: `Bearer ${after.apiKey}` } })).json()) as string[];
    expect(args[args.indexOf("-c") + 1]).toBe("16384");
    // The file does not say how long it was trained for, so no more than this Mac's default.
    await expect(service.setContext("tiny-q4_k_m", 131_072)).rejects.toThrow();
    await expect(service.setContext("tiny-q4_k_m", 1_000)).rejects.toThrow();
    await expect(service.setContext("missing", 16_384)).rejects.toThrow();
  });

  it("downloads the vision part with a model that has one, and loads it", async () => {
    hub.projector = true;
    const { service } = make();
    const spec = (await service.download({ repo: "org/tiny-GGUF" }))!;
    expect(existsSync(join(dir, "tiny-Q4_K_M.mmproj.gguf"))).toBe(true);
    expect(service.view().installed[0]).toMatchObject({ vision: "yes" });
    await service.prepare(spec);
    const args = await argsOf(service.endpoint(spec)!);
    expect(args[args.indexOf("--mmproj") + 1]).toBe(join(dir, "tiny-Q4_K_M.mmproj.gguf"));
  });

  it("keeps the model when its vision part fails, and offers it again", async () => {
    hub.projector = true;
    hub.badProjector = true;
    const { service } = make();
    await service.download({ repo: "org/tiny-GGUF" });
    expect(service.view().installed[0]).toMatchObject({ id: "tiny-q4_k_m", vision: "add", visionSize: PROJ.length });
    hub.badProjector = false;
    await service.download({ vision: "tiny-q4_k_m" });
    expect(service.view().installed[0]).toMatchObject({ vision: "yes" });
  });

  it("adds vision to a model downloaded before, asking the hub at the model's own commit", async () => {
    writeFileSync(join(dir, "tiny-Q4_K_M.gguf"), BYTES);
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      models: [{ id: "tiny-q4_k_m", name: "tiny", license: "mit", repo: "org/tiny-GGUF", commit: COMMIT, file: "tiny-Q4_K_M.gguf", size: BYTES.length, sha256: SHA }],
      pending: null,
    }));
    hub.projector = true;
    const { service } = make();
    expect(service.view().installed[0]).toMatchObject({ vision: "add" });
    const spec = "vunemi:tiny-q4_k_m";
    await service.prepare(spec);
    const before = service.endpoint(spec)!;
    await service.download({ vision: "tiny-q4_k_m" });
    expect(hub.revisions).toBe(1);
    expect(service.view().installed[0]).toMatchObject({ vision: "yes" });
    // Loaded and idle: it comes back with its eyes.
    const after = service.endpoint(spec)!;
    expect(after.baseUrl).not.toBe(before.baseUrl);
    expect(await argsOf(after)).toContain("--mmproj");
  });

  it("stops offering vision when the repository has none", async () => {
    writeFileSync(join(dir, "tiny-Q4_K_M.gguf"), BYTES);
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      models: [{ id: "tiny-q4_k_m", name: "tiny", license: "mit", repo: "org/tiny-GGUF", commit: COMMIT, file: "tiny-Q4_K_M.gguf", size: BYTES.length, sha256: SHA }],
      pending: null,
    }));
    const { service } = make();
    await expect(service.download({ vision: "tiny-q4_k_m" })).rejects.toThrow();
    expect(service.view().installed[0]).toMatchObject({ vision: "no" });
  });

  it("runs the model a task asks for and hands out its address", async () => {
    const { service } = make();
    const spec = (await service.download({ repo: "org/tiny-GGUF" }))!;
    await service.prepare(spec);
    expect(service.endpoint(spec)?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await service.prepare("lmstudio:other"); // not ours: nothing to do
  });

  it("removes a model and its file", async () => {
    const { service } = make();
    await service.download({ repo: "org/tiny-GGUF" });
    await service.remove("tiny-q4_k_m");
    expect(existsSync(join(dir, "tiny-Q4_K_M.gguf"))).toBe(false);
    expect(service.view().installed).toEqual([]);
  });

  it("refuses a repository the hub will not vouch for", async () => {
    const { service } = make();
    await expect(service.download({ repo: "org/missing" })).rejects.toThrow();
    expect(service.view().download).toBeNull();
  });

  it("lists popular models once a day, without the one it already recommends", async () => {
    let lists = 0;
    const entry = (id: string, likes: number, base: string) => ({
      id, likes, gated: false, cardData: { base_model: base }, gguf: { chat_template: "tools", total: 9e9 },
    });
    const fetchFn = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/models") {
        lists++;
        return Response.json(url.searchParams.get("author") === "unsloth"
          ? [
            entry("unsloth/Qwen3.6-35B-A3B-GGUF", 900, "Qwen/Qwen3.6-35B-A3B"),
            entry("unsloth/Qwen3.8-27B-GGUF", 850, "Qwen/Qwen3.8-27B"),
            entry("unsloth/gemma-4-12b-it-GGUF", 800, "google/gemma-4-12b-it"),
            entry("unsloth/gemma-4-E4B-it-GGUF", 700, "google/gemma-4-E4B-it"),
            entry("unsloth/gpt-oss-20b-GGUF", 600, "openai/gpt-oss-20b"),
          ]
          : []);
      }
      return Response.json({
        sha: COMMIT, gated: false, cardData: { license: "apache-2.0" },
        siblings: [{ rfilename: "x-UD-Q4_K_XL.gguf", size: 7e9, lfs: { sha256: SHA } }],
      });
    }) as unknown as typeof fetch;
    service = new EngineService({
      dir, binary: FAKE, totalMemory: 64 * GiB, isBusy: () => false, testModel: async () => true, onChange: () => {},
      hub: { fetchFn },
    });
    const first = await service.popular();
    // The recommendation is left out; the first rows are other makers, one each.
    expect(first.map((p) => p.repo)).toEqual([
      "unsloth/gemma-4-12b-it-GGUF", "unsloth/gpt-oss-20b-GGUF", "unsloth/Qwen3.8-27B-GGUF", "unsloth/gemma-4-E4B-it-GGUF",
    ]);
    expect(first[0]).toMatchObject({ maker: "google", likes: 800, size: 7e9, id: "x-ud-q4_k_xl" });
    const asked = lists;
    await service.popular();
    expect(lists).toBe(asked);
  });

  it("is unavailable without a binary", () => {
    service = new EngineService({ dir, binary: null, totalMemory: 8 * GiB, isBusy: () => false, testModel: async () => true, onChange: () => {} });
    expect(service.view().available).toBe(false);
    expect(service.specs()).toEqual([]);
  });
});

describe("a GGUF file from this Mac", () => {
  function local(name: string, body: Buffer = Buffer.concat([Buffer.from("GGUF"), randomBytes(1_000)])): string {
    const elsewhere = mkdtempSync(join(tmpdir(), "vunemi-local-"));
    const path = join(elsewhere, name);
    writeFileSync(path, body);
    return path;
  }

  it("is copied beside the downloads, tried, and never touched again", async () => {
    const { service, testModel } = make();
    const original = local("my-model-Q4.gguf");
    const spec = await service.addLocal(original);
    expect(spec).toBe("vunemi:my-model-q4");
    expect(testModel).toHaveBeenCalledWith("vunemi:my-model-q4", expect.anything());
    expect(existsSync(join(dir, "my-model-Q4.gguf"))).toBe(true);
    expect(service.view().installed).toMatchObject([{ id: "my-model-q4", vision: "no", toolTest: "ok" }]);
    await service.remove("my-model-q4");
    expect(existsSync(original)).toBe(true);
  });

  it("refuses what isn't a model, a vision part alone, a name it has, or one too large", async () => {
    const { service } = make();
    await expect(service.addLocal(local("notes.gguf", Buffer.from("hello")))).rejects.toThrow();
    await expect(service.addLocal(local("mmproj-F16.gguf"))).rejects.toThrow();
    await service.addLocal(local("twin.gguf"));
    await expect(service.addLocal(local("twin.gguf"))).rejects.toThrow(/twin/);
    const small = new EngineService({ dir, binary: FAKE, totalMemory: 1_000, isBusy: () => false, testModel: vi.fn(async () => true), onChange: () => {} });
    await expect(small.addLocal(local("big.gguf"))).rejects.toThrow();
    expect(existsSync(join(dir, "big.gguf"))).toBe(false);
    await small.dispose();
  });
});
