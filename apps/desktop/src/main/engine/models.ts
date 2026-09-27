import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelId, type ModelSource } from "./catalog.js";
import { partPath } from "./download.js";

/**
 * The models this Mac has downloaded for the built-in engine, and the one
 * download that was cut short, if any. Kept beside the files in
 * `models.json`. File names came from Hugging Face, so each is checked
 * before it is joined to a path.
 */

export interface InstalledModel extends ModelSource {
  id: string;
  name: string;
  license: string;
  /** Whether the model passed Vunemi's tool-calling test after download. */
  toolTest?: "ok" | "failed";
  /** The context length the user chose; when absent, one that suits this Mac's memory. */
  context?: number;
  /** The repository was asked and has no vision part: don't offer one. */
  noProjector?: true;
}

export interface PendingDownload extends ModelSource {
  name: string;
  license: string;
}

interface Stored {
  models: InstalledModel[];
  pending: PendingDownload | null;
}

const SAFE_FILE = /^[^/\\]+\.gguf$/;

/**
 * Where a model's vision part is kept. Every repository names it the same
 * ("mmproj-F16.gguf"), so on disk it is named after its model instead.
 */
export function projectorFile(modelFile: string): string {
  return `${modelFile.replace(/\.gguf$/i, "")}.mmproj.gguf`;
}

export class ModelStore {
  constructor(readonly dir: string) {}

  list(): InstalledModel[] {
    return this.read().models.filter((m) => existsSync(this.pathOf(m)));
  }

  get(id: string): InstalledModel | undefined {
    return this.list().find((m) => m.id === id);
  }

  pathOf(m: ModelSource): string {
    if (!SAFE_FILE.test(m.file)) throw new Error(`Refusing model file name ${m.file}`);
    return join(this.dir, m.file);
  }

  add(m: PendingDownload): InstalledModel {
    this.pathOf(m);
    const entry: InstalledModel = { ...m, id: modelId(m.file) };
    const stored = this.read();
    this.write({
      models: [...stored.models.filter((x) => x.id !== entry.id), entry],
      pending: stored.pending?.file === m.file ? null : stored.pending,
    });
    return entry;
  }

  /** The vision part's path, once it is on disk. */
  projectorPathOf(m: InstalledModel): string | null {
    if (!m.projector) return null;
    const path = join(this.dir, projectorFile(m.file));
    return existsSync(path) ? path : null;
  }

  update(id: string, patch: Pick<InstalledModel, "toolTest" | "context" | "projector" | "noProjector">): void {
    const stored = this.read();
    this.write({ ...stored, models: stored.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  remove(id: string): void {
    const stored = this.read();
    const m = stored.models.find((x) => x.id === id);
    if (!m) return;
    rmSync(this.pathOf(m), { force: true });
    rmSync(partPath(this.dir, m.file), { force: true });
    rmSync(join(this.dir, projectorFile(m.file)), { force: true });
    rmSync(partPath(this.dir, projectorFile(m.file)), { force: true });
    this.write({ ...stored, models: stored.models.filter((x) => x.id !== id) });
  }

  pending(): PendingDownload | null {
    return this.read().pending;
  }

  setPending(p: PendingDownload | null): void {
    if (p) this.pathOf(p);
    this.write({ ...this.read(), pending: p });
  }

  /** Bytes of a download that already arrived. */
  partialBytes(p: ModelSource): number {
    const part = partPath(this.dir, p.file);
    return existsSync(part) ? statSync(part).size : 0;
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, "models.json"), "utf8")) as Partial<Stored>;
      return {
        models: Array.isArray(raw.models) ? raw.models.filter((m) => SAFE_FILE.test(String(m?.file))) : [],
        pending: raw.pending && SAFE_FILE.test(String(raw.pending.file)) ? raw.pending : null,
      };
    } catch {
      return { models: [], pending: null };
    }
  }

  private write(stored: Stored): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, "models.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(stored, null, 2));
    renameSync(`${path}.tmp`, path);
  }
}
