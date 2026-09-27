import type { ModelSource } from "./catalog.js";

/**
 * Finding a model on Hugging Face, for someone who wants something newer
 * than the recommended list. The results are shown, never read by the
 * model; a repository is only a download once the user picks it and main
 * has read its files itself.
 */

export const HF = "https://huggingface.co";

/** Publishers whose GGUF builds people rely on, and the model makers themselves. */
const TRUSTED = new Set([
  "unsloth", "lmstudio-community", "bartowski", "ggml-org",
  "Qwen", "google", "mistralai", "microsoft", "openai", "ibm-granite", "meta-llama", "deepseek-ai", "nvidia",
]);

/** Good quality per byte first; the first that fits the budget wins. */
const PREFERRED = ["UD-Q4_K_XL", "Q4_K_M", "Q4_K_S", "UD-Q3_K_XL", "Q3_K_M"];

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface SearchHit {
  repo: string;
  author: string;
  downloads: number;
  trusted: boolean;
}

export interface RepoFile {
  name: string;
  size: number;
  sha256: string;
}

export type InspectReason = "gated" | "license" | "tooBig" | "noFile" | "notFound";

export type Inspection =
  | { ok: true; source: ModelSource; name: string; license: string }
  | { ok: false; repo: string; reason: InspectReason };

export interface HubOptions {
  fetchFn?: typeof fetch;
  base?: string;
  signal?: AbortSignal;
}

export async function searchModels(text: string, opts: HubOptions = {}): Promise<SearchHit[]> {
  const query = text.trim().slice(0, 100);
  if (!query) return [];
  const url = new URL("/api/models", opts.base ?? HF);
  url.search = new URLSearchParams({ search: query, filter: "gguf", sort: "downloads", limit: "30" }).toString();
  const res = await (opts.fetchFn ?? fetch)(url, { signal: opts.signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Hugging Face search answered ${res.status}`);
  const body = (await res.json()) as { id?: unknown; downloads?: unknown }[];
  const hits = (Array.isArray(body) ? body : []).flatMap((m): SearchHit[] => {
    if (typeof m.id !== "string" || !REPO.test(m.id)) return [];
    const author = m.id.slice(0, m.id.indexOf("/"));
    return [{ repo: m.id, author, downloads: typeof m.downloads === "number" ? m.downloads : 0, trusted: TRUSTED.has(author) }];
  });
  // The server already sorted by downloads; keep that order inside each group.
  return [...hits.filter((h) => h.trusted), ...hits.filter((h) => !h.trusted)];
}

export function pickFile(files: RepoFile[], budget: number): RepoFile | "tooBig" | "none" {
  const usable = files.filter((f) =>
    /^[^/\\]+\.gguf$/i.test(f.name) && !/mmproj|^mtp-|-\d{5}-of-\d{5}\.gguf$/i.test(f.name));
  let sawPreferred = false;
  for (const quant of PREFERRED) {
    const matches = usable.filter((f) => f.name.toLowerCase().endsWith(`${quant.toLowerCase()}.gguf`));
    if (matches.length > 0) sawPreferred = true;
    const fits = matches.filter((f) => f.size <= budget).sort((a, b) => b.size - a.size)[0];
    if (fits) return fits;
  }
  return sawPreferred ? "tooBig" : "none";
}

/** A model's vision part: F16 keeps quality at half of F32's size; BF16 next; else the smallest. */
export function pickProjector(files: RepoFile[]): RepoFile | null {
  const parts = files.filter((f) => /^mmproj[^/\\]*\.gguf$/i.test(f.name));
  return parts.find((f) => /^mmproj-F16\.gguf$/i.test(f.name))
    ?? parts.find((f) => /^mmproj-BF16\.gguf$/i.test(f.name))
    ?? [...parts].sort((a, b) => a.size - b.size)[0]
    ?? null;
}

interface RepoBody {
  sha?: unknown;
  gated?: unknown;
  likes?: unknown;
  cardData?: { license?: unknown; base_model?: unknown };
  tags?: unknown;
  gguf?: { chat_template?: unknown };
  siblings?: { rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown } }[];
}

/** What one repository request returns: files with checksums, and the GGUF's chat template. */
const DETAIL = "blobs=true&expand[]=siblings&expand[]=sha&expand[]=gated&expand[]=cardData&expand[]=likes&expand[]=gguf&expand[]=tags";

async function fetchRepo(repo: string, opts: HubOptions): Promise<RepoBody | null> {
  const res = await (opts.fetchFn ?? fetch)(`${opts.base ?? HF}/api/models/${repo}?${DETAIL}`, {
    signal: opts.signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`);
  return (await res.json()) as RepoBody;
}

function readRepo(repo: string, body: RepoBody | null, budget: number): Inspection {
  const refuse = (reason: InspectReason): Inspection => ({ ok: false, repo, reason });
  if (!body) return refuse("notFound");
  if (body.gated !== undefined && body.gated !== false) return refuse("gated");
  const license = licenseOf(body);
  if (!license) return refuse("license");
  if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) return refuse("notFound");
  const files = (body.siblings ?? []).flatMap((s): RepoFile[] =>
    typeof s.rfilename === "string" && typeof s.size === "number" && typeof s.lfs?.sha256 === "string" && /^[0-9a-f]{64}$/.test(s.lfs.sha256)
      ? [{ name: s.rfilename, size: s.size, sha256: s.lfs.sha256 }]
      : []);
  const picked = pickFile(files, budget);
  if (picked === "tooBig") return refuse("tooBig");
  if (picked === "none") return refuse("noFile");
  const projector = pickProjector(files);
  return {
    ok: true,
    name: picked.name.replace(/\.gguf$/i, ""),
    license,
    source: {
      repo, commit: body.sha, file: picked.name, size: picked.size, sha256: picked.sha256,
      ...(projector && { projector: { file: projector.name, size: projector.size, sha256: projector.sha256 } }),
    },
  };
}

export async function inspectRepo(repo: string, budget: number, opts: HubOptions = {}): Promise<Inspection> {
  if (!REPO.test(repo)) return { ok: false, repo, reason: "notFound" };
  return readRepo(repo, await fetchRepo(repo, opts), budget);
}

export interface PopularModel {
  repo: string;
  /** Who made the model itself (Qwen, google, openai…), not who converted it. */
  maker: string;
  name: string;
  likes: number;
  license: string;
  source: ModelSource;
}

/** Where people get GGUF builds they can rely on, including a maker that publishes its own. */
const QUANTIZERS = ["unsloth", "lmstudio-community", "ggml-org", "google"];

/**
 * Popular is not the same as usable: the most liked GGUF repositories are
 * largely fine-tunes with their safety training removed, image models and
 * embeddings. None of those belong in "a model for this Mac".
 */
const NOT_FOR_VUNEMI = /uncensor|abliterat|heretic|obliterat|crack|image|embed|rerank|asr|tts|diariz|whisper|parakeet|flux|-vl\b|\bvl-|mtp|distill|coder/i;
const CHAT_TAGS = new Set(["text-generation", "image-text-to-text", "any-to-any"]);
/** Each candidate that survives the list costs one request; this is where it stops asking. */
const MAX_DETAILS = 12;
const PER_MAKER = 2;
/** Bytes per parameter of a 4-bit file, a little generous: enough to skip what cannot fit. */
const BYTES_PER_PARAM_Q4 = 0.55;

interface ListEntry {
  id?: unknown;
  likes?: unknown;
  pipeline_tag?: unknown;
  gated?: unknown;
  cardData?: { base_model?: unknown };
  gguf?: { chat_template?: unknown; total?: unknown };
}

/**
 * The most liked chat models from trusted publishers that can call tools
 * (their chat template takes `tools`) and fit this Mac: a few per maker, so
 * the list shows a choice rather than one family. Everything but the file
 * sizes comes with the lists, so only real candidates cost a request.
 */
export async function popularModels(budget: number, opts: HubOptions & { limit?: number } = {}): Promise<PopularModel[]> {
  const limit = opts.limit ?? 6;
  const lists = await Promise.all(QUANTIZERS.map(async (author): Promise<ListEntry[]> => {
    const url = new URL("/api/models", opts.base ?? HF);
    url.search = new URLSearchParams({ author, filter: "gguf", sort: "likes", limit: "40" }).toString() +
      ["likes", "pipeline_tag", "gated", "cardData", "gguf"].map((f) => `&expand[]=${f}`).join("");
    try {
      const res = await (opts.fetchFn ?? fetch)(url, { signal: opts.signal ?? AbortSignal.timeout(10_000) });
      const body = res.ok ? await res.json() : [];
      return Array.isArray(body) ? (body as ListEntry[]) : [];
    } catch {
      return [];
    }
  }));

  const candidates = lists.flat().flatMap((m) => {
    if (typeof m.id !== "string" || !REPO.test(m.id) || NOT_FOR_VUNEMI.test(m.id)) return [];
    if (m.pipeline_tag !== undefined && !CHAT_TAGS.has(String(m.pipeline_tag))) return [];
    if (m.gated !== undefined && m.gated !== false) return [];
    const template = m.gguf?.chat_template;
    if (typeof template !== "string" || !template.includes("tools")) return [];
    const params = m.gguf?.total;
    if (typeof params === "number" && params * BYTES_PER_PARAM_Q4 > budget) return [];
    const base = baseModel(m) ?? m.id.split("/")[1]!.replace(/-GGUF$/i, "");
    const maker = base.includes("/") ? base.slice(0, base.indexOf("/")) : m.id.slice(0, m.id.indexOf("/"));
    return [{ repo: m.id, likes: typeof m.likes === "number" ? m.likes : 0, base: base.toLowerCase(), maker }];
  }).sort((a, b) => b.likes - a.likes);

  const found: PopularModel[] = [];
  const bases = new Set<string>();
  const perMaker = new Map<string, number>();
  let asked = 0;
  for (const c of candidates) {
    if (found.length >= limit || asked >= MAX_DETAILS) break;
    if (bases.has(c.base) || (perMaker.get(c.maker) ?? 0) >= PER_MAKER) continue;
    asked++;
    const result = readRepo(c.repo, await fetchRepo(c.repo, opts).catch(() => null), budget);
    if (!result.ok) continue;
    bases.add(c.base);
    perMaker.set(c.maker, (perMaker.get(c.maker) ?? 0) + 1);
    found.push({
      repo: c.repo,
      maker: c.maker,
      name: c.repo.split("/")[1]!.replace(/[-_]GGUF$/i, ""),
      likes: c.likes,
      license: result.license,
      source: result.source,
    });
  }
  return found;
}

function baseModel(body: { cardData?: { base_model?: unknown } }): string | null {
  const base = body.cardData?.base_model;
  const first = Array.isArray(base) ? base[0] : base;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

function licenseOf(body: { cardData?: { license?: unknown }; tags?: unknown }): string | null {
  const card = body.cardData?.license;
  if (typeof card === "string" && card.trim()) return card.trim();
  const tag = Array.isArray(body.tags) ? body.tags.find((t): t is string => typeof t === "string" && t.startsWith("license:")) : undefined;
  return tag ? tag.slice("license:".length) : null;
}
