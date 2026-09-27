import { describe, expect, it, vi } from "vitest";
import { GiB } from "../../src/main/engine/catalog.js";
import { inspectRepo, pickFile, pickProjector, popularModels, searchModels, type RepoFile } from "../../src/main/engine/search.js";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const file = (name: string, gb: number): RepoFile => ({ name, size: Math.round(gb * 1e9), sha256: SHA });

describe("searching Hugging Face", () => {
  it("asks for GGUF models by downloads and puts trusted publishers first", async () => {
    const fetchFn = vi.fn(async (_url: URL | string) => Response.json([
      { id: "someone/gemma-4-uncensored-GGUF", downloads: 900 },
      { id: "unsloth/gemma-4-12b-it-GGUF", downloads: 500 },
      { id: "not a repo", downloads: 1 },
      { id: "google/gemma-4-12B-it-qat-q4_0-gguf", downloads: 400 },
    ]));
    const hits = await searchModels("  gemma  ", { fetchFn: fetchFn as unknown as typeof fetch });
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://huggingface.co/api/models");
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "gemma", filter: "gguf", sort: "downloads", limit: "30" });
    expect(hits.map((h) => [h.repo, h.trusted])).toEqual([
      ["unsloth/gemma-4-12b-it-GGUF", true],
      ["google/gemma-4-12B-it-qat-q4_0-gguf", true],
      ["someone/gemma-4-uncensored-GGUF", false],
    ]);
  });

  it("does not search for nothing", async () => {
    const fetchFn = vi.fn();
    expect(await searchModels("   ", { fetchFn: fetchFn as unknown as typeof fetch })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("choosing the file", () => {
  const files = [
    file("m-BF16.gguf", 24), file("m-Q8_0.gguf", 12.7), file("m-Q4_K_M.gguf", 7.1),
    file("m-UD-Q4_K_XL.gguf", 7.4), file("m-UD-Q3_K_XL.gguf", 6.0), file("mmproj-F16.gguf", 0.2),
    file("MTP/mtp-m-Q8_0.gguf", 0.5), file("big-Q4_K_M-00001-of-00002.gguf", 1),
  ];

  it("takes the best quantisation that fits half the memory", () => {
    expect(pickFile(files, 16 * GiB)).toMatchObject({ name: "m-UD-Q4_K_XL.gguf" });
    expect(pickFile(files, 7 * 1e9)).toMatchObject({ name: "m-UD-Q3_K_XL.gguf" });
  });

  it("says when nothing fits, and when there is nothing to take", () => {
    expect(pickFile(files, 1e9)).toBe("tooBig");
    expect(pickFile([file("mmproj-F16.gguf", 0.2), file("m-F16.gguf", 2)], 16 * GiB)).toBe("none");
  });
});

describe("choosing the vision part", () => {
  it("prefers F16, then BF16, then the smallest one", () => {
    expect(pickProjector([file("mmproj-F32.gguf", 1.8), file("mmproj-BF16.gguf", 0.9), file("mmproj-F16.gguf", 0.9)])).toMatchObject({ name: "mmproj-F16.gguf" });
    expect(pickProjector([file("mmproj-F32.gguf", 1.8), file("mmproj-BF16.gguf", 0.9)])).toMatchObject({ name: "mmproj-BF16.gguf" });
    expect(pickProjector([file("mmproj-F32.gguf", 1.8), file("mmproj-q8.gguf", 0.5)])).toMatchObject({ name: "mmproj-q8.gguf" });
    expect(pickProjector([file("m-Q4_K_M.gguf", 5)])).toBeNull();
  });
});

describe("inspecting a repository", () => {
  const repo = (over: object = {}) => ({
    sha: COMMIT,
    gated: false,
    cardData: { license: "apache-2.0" },
    siblings: [
      { rfilename: "m-Q4_K_M.gguf", size: 5e9, lfs: { sha256: SHA } },
      { rfilename: "README.md", size: 10 },
    ],
    ...over,
  });
  const fetchWith = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("pins the commit and the file's checksum", async () => {
    const fetchFn = fetchWith(repo());
    expect(await inspectRepo("org/m-GGUF", 16 * GiB, { fetchFn })).toEqual({
      ok: true,
      name: "m-Q4_K_M",
      license: "apache-2.0",
      source: { repo: "org/m-GGUF", commit: COMMIT, file: "m-Q4_K_M.gguf", size: 5e9, sha256: SHA },
    });
    expect(String((fetchFn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0])).toMatch(/^https:\/\/huggingface\.co\/api\/models\/org\/m-GGUF\?blobs=true&/);
  });

  it("brings the vision part along when the repository has one", async () => {
    const siblings = [...repo().siblings, { rfilename: "mmproj-F16.gguf", size: 9e8, lfs: { sha256: SHA } }];
    const result = await inspectRepo("org/m-GGUF", 16 * GiB, { fetchFn: fetchWith(repo({ siblings })) });
    expect(result).toMatchObject({ ok: true, source: { projector: { file: "mmproj-F16.gguf", size: 9e8, sha256: SHA } } });
  });

  it("reads the licence from the tags when the card has none", async () => {
    const result = await inspectRepo("org/m", 16 * GiB, { fetchFn: fetchWith(repo({ cardData: {}, tags: ["gguf", "license:mit"] })) });
    expect(result).toMatchObject({ ok: true, license: "mit" });
  });

  it("refuses what it cannot download", async () => {
    expect(await inspectRepo("org/m", 16 * GiB, { fetchFn: fetchWith(repo({ gated: "auto" })) })).toEqual({ ok: false, repo: "org/m", reason: "gated" });
    expect(await inspectRepo("org/m", 16 * GiB, { fetchFn: fetchWith(repo({ cardData: {} })) })).toEqual({ ok: false, repo: "org/m", reason: "license" });
    expect(await inspectRepo("org/m", 1e9, { fetchFn: fetchWith(repo()) })).toEqual({ ok: false, repo: "org/m", reason: "tooBig" });
    expect(await inspectRepo("org/m", 16 * GiB, { fetchFn: fetchWith(repo({ siblings: [] })) })).toEqual({ ok: false, repo: "org/m", reason: "noFile" });
    expect(await inspectRepo("org/m", 16 * GiB, { fetchFn: fetchWith({}, 404) })).toEqual({ ok: false, repo: "org/m", reason: "notFound" });
  });

  it("never asks for a path that is not a repository", async () => {
    const fetchFn = vi.fn();
    expect(await inspectRepo("../../etc", 16 * GiB, { fetchFn: fetchFn as unknown as typeof fetch })).toEqual({ ok: false, repo: "../../etc", reason: "notFound" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("popular models", () => {
  type Entry = { id: string; likes: number; pipeline_tag?: string; gated?: unknown; cardData?: object; gguf?: object };
  const entry = (id: string, likes: number, base: string, over: Partial<Entry> = {}): Entry => ({
    id, likes, gated: false, cardData: { base_model: [base] }, gguf: { chat_template: "{% if tools %}…{% endif %}", total: 9e9 }, ...over,
  });
  const detail = (over: Record<string, unknown> = {}) => ({
    sha: COMMIT,
    gated: false,
    cardData: { license: "apache-2.0" },
    siblings: [{ rfilename: "m-Q4_K_M.gguf", size: 5e9, lfs: { sha256: SHA } }],
    ...over,
  });

  function hub(lists: Record<string, Entry[]>, details: Record<string, unknown>) {
    const asked: string[] = [];
    const fetchFn = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/models") return Response.json(lists[url.searchParams.get("author")!] ?? []);
      const repo = url.pathname.replace("/api/models/", "");
      asked.push(repo);
      return details[repo] ? Response.json(details[repo]) : Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFn, asked };
  }

  it("keeps chat models that can use tools and fit, most liked first, a few per maker", async () => {
    const { fetchFn, asked } = hub(
      {
        unsloth: [
          entry("unsloth/Qwen-A-GGUF", 900, "Qwen/Qwen-A"),
          entry("unsloth/Qwen-A-Uncensored-GGUF", 5000, "someone/Qwen-A-Uncensored"),
          entry("unsloth/Old-Chat-GGUF", 800, "old/Old-Chat", { gguf: { chat_template: "{{ messages }}" } }),
          entry("unsloth/Huge-GGUF", 700, "huge/Huge"),
          entry("unsloth/Giant-GGUF", 650, "giant/Giant", { gguf: { chat_template: "tools", total: 600e9 } }),
          entry("unsloth/Qwen-B-GGUF", 600, "Qwen/Qwen-B"),
          entry("unsloth/Qwen-C-GGUF", 550, "Qwen/Qwen-C"),
          entry("unsloth/Some-Image-GGUF", 500, "x/Some-Image", { pipeline_tag: "text-to-image" }),
          entry("unsloth/Locked-GGUF", 450, "locked/Locked", { gated: "manual" }),
        ],
        "lmstudio-community": [entry("lmstudio-community/Qwen-A-GGUF", 300, "Qwen/Qwen-A")],
        google: [entry("google/gemma-x-it-GGUF", 400, "google/gemma-x-it")],
      },
      {
        "unsloth/Qwen-A-GGUF": detail(),
        "unsloth/Huge-GGUF": detail({ siblings: [{ rfilename: "h-Q4_K_M.gguf", size: 400e9, lfs: { sha256: SHA } }] }),
        "unsloth/Qwen-B-GGUF": detail(),
        "google/gemma-x-it-GGUF": detail({ cardData: { license: "gemma" } }),
      },
    );
    const popular = await popularModels(16 * GiB, { fetchFn });
    expect(popular.map((p) => [p.repo, p.maker, p.likes, p.license])).toEqual([
      ["unsloth/Qwen-A-GGUF", "Qwen", 900, "apache-2.0"],
      ["unsloth/Qwen-B-GGUF", "Qwen", 600, "apache-2.0"],
      ["google/gemma-x-it-GGUF", "google", 400, "gemma"],
    ]);
    expect(popular[0]!.source).toMatchObject({ repo: "unsloth/Qwen-A-GGUF", commit: COMMIT, file: "m-Q4_K_M.gguf" });
    // Only real candidates cost a request.
    expect(asked).toEqual(["unsloth/Qwen-A-GGUF", "unsloth/Huge-GGUF", "unsloth/Qwen-B-GGUF", "google/gemma-x-it-GGUF"]);
  });

  it("stops at the limit without reading every repository", async () => {
    const list = Array.from({ length: 20 }, (_, i) => entry(`unsloth/M${i}-GGUF`, 100 - i, `maker${i}/M${i}`));
    const details = Object.fromEntries(list.map((m) => [m.id, detail({ cardData: { license: "mit" } })]));
    const { fetchFn, asked } = hub({ unsloth: list }, details);
    const popular = await popularModels(16 * GiB, { fetchFn, limit: 3 });
    expect(popular).toHaveLength(3);
    expect(asked).toHaveLength(3);
  });
});
