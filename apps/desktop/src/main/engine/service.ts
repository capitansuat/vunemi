import { constants, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { t } from "@vunemi/i18n";
import type { CatalogView, DownloadRequest, DownloadView, EngineView, InspectView, PopularView, SearchHitView } from "../../shared/ipc.js";
import { CATALOG, contextFor, displayName, memoryBudget, modelId, recommend, smaller, type CatalogEntry, type ModelSource, type ProjectorSource } from "./catalog.js";
import { download, DownloadError, freeBytesOf, partPath } from "./download.js";
import { Engine, type Endpoint } from "./engine.js";
import { isGguf, modelShape, type ModelShape } from "./gguf.js";
import { ModelStore, projectorFile, type InstalledModel, type PendingDownload } from "./models.js";
import { HF, inspectRepo, pickProjector, popularModels, searchModels, type HubOptions, type RepoFile } from "./search.js";
import type { FitRequest } from "../models/manager.js";
import { need } from "../models/memory.js";

/**
 * Everything the rest of main needs from the built-in engine, in one place:
 * what to offer, the one download that may be running, the models on disk,
 * and the server that runs them.
 */

export interface EngineServiceOptions {
  dir: string;
  binary: string | null;
  totalMemory: number;
  isBusy: () => boolean;
  /** Vunemi's tool-calling test, run after a download. */
  testModel: (spec: string, endpoint: Endpoint) => Promise<boolean>;
  onChange: (view: EngineView) => void;
  hub?: HubOptions;
  allowUrl?: (url: URL) => boolean;
  freeBytes?: (dir: string) => Promise<number>;
  idleMs?: number;
  /** Fits the context to the memory there is (models/manager.ts); without it the wanted length is used. */
  manager?: { fit(req: FitRequest): Promise<{ context: number; tight: boolean }> };
}

const PREFIX = "vunemi:";
/** A first answer from a freshly loaded model can miss; the test is tried this many times. */
const TOOL_TEST_TRIES = 3;
/** The shortest context length the setting accepts. */
const MIN_CONTEXT = 4096;
/** Popularity changes slowly; Hugging Face is asked at most this often. */
const POPULAR_TTL_MS = 24 * 60 * 60_000;

/** Bumped when what the list holds or how it is ordered changes, so an old day's answer is not reused. */
const POPULAR_VERSION = 2;

interface PopularCache {
  version: number;
  at: number;
  budget: number;
  items: PopularView[];
}

/** What `prepare` opened the chat model with. */
export interface PreparedModel {
  context: number;
  /** The length the model's setting asks for. */
  wanted: number;
  /** Not even the shortest context fitted; it opened anyway. */
  tight: boolean;
  /** This call launched the server; false when the loaded one was reused. */
  launched: boolean;
}

export class EngineService {
  private readonly store: ModelStore;
  private readonly engine: Engine;
  private active: { ctrl: AbortController; view: DownloadView } | null = null;
  private popularRun: Promise<PopularView[]> | null = null;
  /** Trained context lengths read from the files' headers, by path. */
  private readonly shapes = new Map<string, ModelShape>();
  /** What the loaded model was launched for; it is reused while the wanted length is unchanged. */
  private launched: { wanted: number; tight: boolean } | null = null;

  constructor(private readonly opts: EngineServiceOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.store = new ModelStore(opts.dir);
    this.engine = new Engine({
      binary: opts.binary,
      isBusy: opts.isBusy,
      pidFile: join(opts.dir, "engine.pid"),
      onChange: () => this.changed(),
      ...(opts.idleMs !== undefined && { idleMs: opts.idleMs }),
    });
  }

  view(): EngineView {
    const rec = recommend(this.opts.totalMemory);
    const choices = [rec];
    for (let next = smaller(rec.file); next; next = smaller(next.file)) choices.push(next);
    const pending = this.store.pending();
    return {
      available: this.opts.binary !== null,
      totalMemory: this.opts.totalMemory,
      engine: this.engine.snapshot,
      recommended: catalogView(rec),
      choices: choices.map(catalogView),
      installed: this.store.list().map((m) => {
        const vision = this.store.projectorPathOf(m) ? "yes" : m.noProjector ? "no" : "add";
        const visionSize = (m.projector ?? catalogProjector(m))?.size;
        return {
          id: m.id, name: displayName(m.file, m.name), size: m.size, license: m.license,
          context: this.contextOf(m), maxContext: this.allowedContext(m), vision,
          weights: this.weightsOf(m),
          ...(this.shapeOf(this.store.pathOf(m)).kvBytesPerToken !== null && { kvBytesPerToken: this.shapeOf(this.store.pathOf(m)).kvBytesPerToken! }),
          ...(vision === "add" && visionSize !== undefined && { visionSize }),
          ...(m.toolTest && { toolTest: m.toolTest }),
        };
      }),
      download: this.active?.view ?? (pending ? {
        id: modelId(pending.file), name: displayName(pending.file, pending.name), received: this.store.partialBytes(pending),
        total: pending.size, bytesPerSecond: 0, state: "paused",
      } : null),
    };
  }

  /** The specs the model picker offers. */
  specs(): string[] {
    return this.opts.binary ? this.store.list().map((m) => PREFIX + m.id) : [];
  }

  search(text: string): Promise<SearchHitView[]> {
    return searchModels(text, this.opts.hub);
  }

  /**
   * Popular models that fit this Mac, from a day-old answer when there is
   * one. The recommended model is left out: it is already on the card.
   */
  popular(): Promise<PopularView[]> {
    this.popularRun ??= this.loadPopular().finally(() => {
      this.popularRun = null;
    });
    return this.popularRun;
  }

  private async loadPopular(): Promise<PopularView[]> {
    const path = join(this.opts.dir, "popular.json");
    const budget = memoryBudget(this.opts.totalMemory);
    let cached: PopularCache | null = null;
    try {
      cached = JSON.parse(readFileSync(path, "utf8")) as PopularCache;
    } catch {
      cached = null;
    }
    const usable = cached && cached.version === POPULAR_VERSION && cached.budget === budget && Array.isArray(cached.items) ? cached : null;
    if (usable && Date.now() - usable.at < POPULAR_TTL_MS) return usable.items;
    try {
      const recommended = recommend(this.opts.totalMemory);
      const found = await popularModels(budget, { ...this.opts.hub, limit: 7 });
      const items = varied(found.filter((p) => p.repo !== recommended.repo), recommended.maker).slice(0, 6).map((p): PopularView => ({
        id: modelId(p.source.file), repo: p.repo, maker: p.maker, name: p.name, likes: p.likes, license: p.license, size: p.source.size,
      }));
      writeFileSync(path, JSON.stringify({ version: POPULAR_VERSION, at: Date.now(), budget, items } satisfies PopularCache));
      return items;
    } catch {
      return usable?.items ?? [];
    }
  }

  async inspect(repo: string): Promise<InspectView> {
    const result = await inspectRepo(repo, memoryBudget(this.opts.totalMemory), this.opts.hub);
    return result.ok
      ? { ok: true, repo, name: result.name, license: result.license, size: result.source.size }
      : result;
  }

  /** Resolves to the new model's spec, or null when the user cancelled. */
  async download(req: DownloadRequest): Promise<string | null> {
    if (!this.opts.binary) throw new Error(t("engine.error.absent"));
    if (this.active) throw new Error(t("engine.error.busy"));
    if ("vision" in req) return this.addVision(req.vision);
    const source = await this.resolve(req);
    const id = modelId(source.file);
    this.store.setPending(source);
    const ctrl = new AbortController();
    const total = source.size + (source.projector?.size ?? 0);
    this.active = {
      ctrl,
      view: { id, name: displayName(source.file, source.name), received: this.store.partialBytes(source), total, bytesPerSecond: 0, state: "downloading" },
    };
    this.changed();
    try {
      await download(source, this.opts.dir, this.fetching(ctrl.signal, 0));
    } catch (err) {
      return this.failed(err, true);
    }
    this.store.add(source);
    if (source.projector) {
      // The model is usable without it; a failed vision part is offered again in Settings.
      try {
        await download(projectorSource(source, source.projector), this.opts.dir, { ...this.fetching(ctrl.signal, source.size), saveAs: projectorFile(source.file) });
      } catch (err) {
        if (err instanceof DownloadError && err.code === "cancelled") {
          this.active = null;
          this.changed();
          return null;
        }
      }
    } else {
      this.store.update(id, { noProjector: true });
    }
    this.active.view = { ...this.active.view, state: "testing" };
    this.changed();
    const spec = PREFIX + id;
    this.store.update(id, { toolTest: (await this.testTools(spec)) ? "ok" : "failed" });
    this.active = null;
    this.changed();
    return spec;
  }

  /**
   * Adds a GGUF file the user already has. It is copied beside the downloaded
   * models (on the same APFS volume a clone: instant, no extra space), so
   * moving or deleting the original later doesn't break the model, and
   * deleting the model here never touches the original.
   */
  async addLocal(path: string): Promise<string> {
    if (!this.opts.binary) throw new Error(t("engine.error.absent"));
    if (this.active) throw new Error(t("engine.error.busy"));
    const file = basename(path);
    if (!/^[^/\\.][^/\\]*\.gguf$/.test(file) || /mmproj/i.test(file) || !isGguf(path)) throw new Error(t("engine.local.notModel"));
    const size = statSync(path).size;
    const budget = memoryBudget(this.opts.totalMemory);
    if (size > budget) throw new Error(t("engine.local.tooLarge", { size: formatGB(size), budget: formatGB(budget) }));
    const id = modelId(file);
    if (this.store.list().some((m) => m.id === id)) throw new Error(t("engine.local.exists", { name: file }));
    const ctrl = new AbortController();
    this.active = { ctrl, view: { id, name: displayName(file, file.replace(/\.gguf$/i, "")), received: 0, total: size, bytesPerSecond: 0, state: "downloading" } };
    this.changed();
    const final = join(this.opts.dir, file);
    const part = partPath(this.opts.dir, file);
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      try {
        await copyFile(path, part, constants.COPYFILE_FICLONE_FORCE);
      } catch {
        // Another volume, or a file system without clones: a real copy, if it fits.
        rmSync(part, { force: true });
        if ((await (this.opts.freeBytes ?? freeBytesOf)(this.opts.dir)) < size) throw new Error(t("engine.error.space", { size: formatGB(size) }));
        await copyFile(path, part);
      }
      renameSync(part, final);
    } catch (err) {
      rmSync(part, { force: true });
      this.active = null;
      this.changed();
      throw err;
    }
    this.store.add({ repo: "", commit: "", file, size, sha256: "", name: file.replace(/\.gguf$/i, ""), license: "local file" });
    this.store.update(id, { noProjector: true });
    this.active.view = { ...this.active.view, received: size, state: "testing" };
    this.changed();
    const spec = PREFIX + id;
    this.store.update(id, { toolTest: (await this.testTools(spec)) ? "ok" : "failed" });
    this.active = null;
    this.changed();
    return spec;
  }

  private async testTools(spec: string): Promise<boolean> {
    for (let i = 0; i < TOOL_TEST_TRIES; i++) {
      try {
        await this.prepare(spec);
        const endpoint = this.endpoint(spec);
        if (endpoint && (await this.opts.testModel(spec, endpoint))) return true;
      } catch {
        // A timeout or a refused first answer: try again.
      }
    }
    return false;
  }

  /** The answer of a test the user ran from Settings replaces the one from the download. */
  recordToolTest(spec: string, ok: boolean): void {
    if (!spec.startsWith(PREFIX)) return;
    const id = spec.slice(PREFIX.length);
    if (!this.store.get(id)) return;
    this.store.update(id, { toolTest: ok ? "ok" : "failed" });
    this.changed();
  }

  /**
   * How much text the model keeps in view at once. The next task loads it
   * with the new length; when it is loaded and nothing runs, it reloads now.
   */
  async setContext(id: string, context: number): Promise<void> {
    const m = this.store.get(id);
    if (!m) throw new Error(t("engine.error.missing"));
    if (!Number.isInteger(context) || context < MIN_CONTEXT || context > this.allowedContext(m)) throw new Error(t("engine.error.context"));
    this.store.update(id, { context });
    this.changed();
    if (this.engine.snapshot.model === id && !this.opts.isBusy()) await this.prepare(PREFIX + id);
  }

  /**
   * Adds the vision part to a model downloaded without it. The repository is
   * read at the model's own commit, so the part matches the weights.
   */
  private async addVision(id: string): Promise<string | null> {
    const m = this.store.get(id);
    if (!m) throw new Error(t("engine.error.missing"));
    const projector = m.projector ?? catalogProjector(m) ?? (await this.projectorAt(m));
    if (!projector) {
      this.store.update(id, { noProjector: true });
      this.changed();
      throw new Error(t("engine.error.noVision"));
    }
    this.store.update(id, { projector });
    const ctrl = new AbortController();
    this.active = {
      ctrl,
      view: { id, name: displayName(m.file, m.name), received: 0, total: projector.size, bytesPerSecond: 0, state: "downloading", vision: true },
    };
    this.changed();
    try {
      await download(projectorSource(m, projector), this.opts.dir, { ...this.fetching(ctrl.signal, 0), saveAs: projectorFile(m.file) });
    } catch (err) {
      return this.failed(err, false);
    }
    this.active = null;
    this.changed();
    // Loaded and idle: load it again, now with its vision part.
    if (this.engine.snapshot.model === id && !this.opts.isBusy()) await this.prepare(PREFIX + id).catch(() => {});
    return PREFIX + id;
  }

  private async projectorAt(m: InstalledModel): Promise<ProjectorSource | null> {
    const hub = this.opts.hub ?? {};
    const res = await (hub.fetchFn ?? fetch)(`${hub.base ?? HF}/api/models/${m.repo}/revision/${m.commit}?blobs=true`, {
      signal: hub.signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(t("engine.error.network"));
    const body = (await res.json()) as { siblings?: { rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown } }[] };
    const files = (body.siblings ?? []).flatMap((s): RepoFile[] =>
      typeof s.rfilename === "string" && typeof s.size === "number" && typeof s.lfs?.sha256 === "string" && /^[0-9a-f]{64}$/.test(s.lfs.sha256)
        ? [{ name: s.rfilename, size: s.size, sha256: s.lfs.sha256 }]
        : []);
    const picked = pickProjector(files);
    return picked && { file: picked.name, size: picked.size, sha256: picked.sha256 };
  }

  /** Download options, with progress counted from `offset` (what came before in this download). */
  private fetching(signal: AbortSignal, offset: number) {
    return {
      signal,
      onProgress: (p: { received: number; total: number; bytesPerSecond: number }) => {
        if (!this.active) return;
        this.active.view = { ...this.active.view, received: offset + p.received, bytesPerSecond: p.bytesPerSecond };
        this.changed();
      },
      ...(this.opts.hub?.fetchFn && { fetchFn: this.opts.hub.fetchFn }),
      ...(this.opts.hub?.base && { base: this.opts.hub.base }),
      ...(this.opts.allowUrl && { allowUrl: this.opts.allowUrl }),
      ...(this.opts.freeBytes && { freeBytes: this.opts.freeBytes }),
    };
  }

  /** Ends a download that went wrong: null when cancelled, a sentence otherwise. */
  private failed(err: unknown, model: boolean): null {
    this.active = null;
    this.changed();
    if (err instanceof DownloadError) {
      if (err.code === "cancelled") return null;
      if (err.code === "integrity" && model) this.store.setPending(null);
      throw new Error(t(`engine.error.${err.code}`, { size: formatGB(err.needed ?? 0) }));
    }
    throw err;
  }

  cancel(): void {
    this.active?.ctrl.abort();
  }

  async remove(id: string): Promise<void> {
    if (this.engine.snapshot.model === id) await this.engine.stop();
    this.store.remove(id);
    this.changed();
  }

  /** Before a task: make sure the model it names is loaded. Other providers need nothing. */
  async prepare(spec: string): Promise<PreparedModel | null> {
    if (!spec.startsWith(PREFIX)) return null;
    const id = spec.slice(PREFIX.length);
    const m = this.store.get(id);
    if (!m) throw new Error(t("engine.error.missing"));
    const projector = this.store.projectorPathOf(m);
    const path = this.store.pathOf(m);
    const wanted = this.contextOf(m);
    const loaded = this.engine.loaded();
    // Loaded, perhaps with a shorter context than wanted: a reload would throw its cache away.
    if (loaded && this.launched?.wanted === wanted && loaded.id === id && loaded.path === path && (loaded.projector ?? null) === (projector ?? null)) {
      await this.engine.ensure(loaded);
      return { context: loaded.context, wanted, tight: this.launched.tight, launched: false };
    }
    const weights = this.weightsOf(m);
    const kv = this.shapeOf(path).kvBytesPerToken;
    const fit = this.opts.manager
      ? await this.opts.manager.fit({ wanted, need: (context) => need(weights, kv, context), ...(loaded && { replacing: "chat" as const }) })
      : { context: wanted, tight: false };
    this.launched = { wanted, tight: fit.tight };
    await this.engine.ensure({ id, path, context: fit.context, ...(projector && { projector }) });
    return { context: fit.context, wanted, tight: fit.tight, launched: true };
  }

  /** The chat model's server while one runs, for the model manager. */
  pid(): number | null {
    return this.engine.pid();
  }

  /** Bytes of the model file the loaded server maps; its footprint leaves them out. */
  mapped(): number {
    const loaded = this.engine.loaded();
    const m = loaded ? this.store.get(loaded.id) : undefined;
    return m ? m.size : 0;
  }

  /** Stops the chat model's server; the next task loads it again. */
  async unload(): Promise<void> {
    await this.engine.stop();
  }

  endpoint(spec: string): Endpoint | null {
    return spec.startsWith(PREFIX) ? this.engine.endpoint(spec.slice(PREFIX.length)) : null;
  }

  /** Load in the background, e.g. when the user picks the model; failures show in the view. */
  warm(spec: string): void {
    void this.prepare(spec).catch(() => {});
  }

  touch(): void {
    this.engine.touch();
  }

  async dispose(): Promise<void> {
    this.cancel();
    await this.engine.stop();
  }

  private async resolve(req: Exclude<DownloadRequest, { vision: string }>): Promise<PendingDownload> {
    if ("catalog" in req) {
      const entry = CATALOG.find((e) => modelId(e.file) === req.catalog);
      if (!entry) throw new Error(t("engine.error.missing"));
      const { name, license, repo, commit, file, size, sha256, projector } = entry;
      return { name, license, repo, commit, file, size, sha256, ...(projector && { projector }) };
    }
    if ("resume" in req) {
      const pending = this.store.pending();
      if (!pending) throw new Error(t("engine.error.missing"));
      return pending;
    }
    // A repository the user picked: read it again here rather than trust
    // anything the window sent back.
    const result = await inspectRepo(req.repo, memoryBudget(this.opts.totalMemory), this.opts.hub);
    if (!result.ok) throw new Error(t(`engine.search.reason.${result.reason}`));
    return { ...result.source, name: result.name, license: result.license };
  }

  private maxContext(m: InstalledModel): number | null {
    const path = this.store.pathOf(m);
    return this.shapeOf(path).context;
  }

  private shapeOf(path: string): ModelShape {
    if (!this.shapes.has(path)) this.shapes.set(path, modelShape(path));
    return this.shapes.get(path)!;
  }

  /** What loading takes before the context: the weights, plus the vision part when it's there. */
  private weightsOf(m: InstalledModel): number {
    const projector = this.store.projectorPathOf(m);
    let extra = 0;
    try {
      if (projector) extra = statSync(projector).size;
    } catch {
      // Counted as nothing: the estimate is a guide, not a gate.
    }
    return m.size + extra;
  }

  /** Longer than the model was trained for gives poor answers; when the file does not say, no more than the default. */
  private allowedContext(m: InstalledModel): number {
    return this.maxContext(m) ?? contextFor(this.opts.totalMemory);
  }

  private contextOf(m: InstalledModel): number {
    return Math.min(m.context ?? contextFor(this.opts.totalMemory), this.allowedContext(m));
  }

  private changed(): void {
    this.opts.onChange(this.view());
  }
}

/**
 * The first few rows are what most people look at: one per maker there, and
 * not the maker of the recommendation above them, so the choice is a real
 * one. The rest follow by likes.
 */
function varied<T extends { maker: string }>(items: T[], avoid: string): T[] {
  const first: T[] = [];
  const makers = new Set([avoid.toLowerCase()]);
  for (const item of items) {
    if (makers.has(item.maker.toLowerCase())) continue;
    makers.add(item.maker.toLowerCase());
    first.push(item);
  }
  return [...first, ...items.filter((item) => !first.includes(item))];
}

/** A catalogue model's vision part, known without asking the hub. */
function catalogProjector(m: ModelSource): ProjectorSource | undefined {
  return CATALOG.find((e) => e.repo === m.repo && e.commit === m.commit && e.file === m.file)?.projector;
}

/** The vision part as a download of its own: same repository, same commit. */
function projectorSource(model: ModelSource, p: ProjectorSource): ModelSource {
  return { repo: model.repo, commit: model.commit, file: p.file, size: p.size, sha256: p.sha256 };
}

function catalogView(e: CatalogEntry): CatalogView {
  return { id: modelId(e.file), name: displayName(e.file, e.name), size: e.size, license: e.license };
}

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
