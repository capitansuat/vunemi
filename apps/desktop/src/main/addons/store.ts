/**
 * Installs, finds and removes add-ons.
 *
 * An add-on is ready only when the pinned release has been downloaded,
 * matched its SHA-256, unpacked, and shown to be signed by the team that
 * publishes it. Everything before that happens in folders nothing runs from,
 * so a download that stopped halfway can never be mistaken for a program.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddonFailure, AddonStatus, AddonView } from "../../shared/ipc.js";
import { DownloadError, downloadPinned, type DownloadOptions, type PinnedFile } from "../engine/download.js";
import { ADDONS, ADDON_TEAM, addonUrl, allowedAddonUrl, type AddonId, type AddonSource } from "./catalog.js";

const exec = promisify(execFile);

export type { AddonFailure, AddonStatus };
export type AddonEntry = AddonView;

export interface AddonsOptions {
  /** Vunemi's own folder for add-ons. */
  dir: string;
  trash: (path: string) => Promise<void>;
  onChange?: (id: AddonId, status: AddonStatus) => void;
  /** Replaced in tests. */
  catalog?: readonly AddonSource[];
  download?: (src: PinnedFile, dir: string, opts: DownloadOptions) => Promise<string>;
  unpack?: (zip: string, into: string) => Promise<void>;
  /** The team that signed the program, when its signature is whole. */
  signedBy?: (binary: string) => Promise<string | null>;
}

async function ditto(zip: string, into: string): Promise<void> {
  await exec("/usr/bin/ditto", ["-x", "-k", zip, into]);
}

async function teamOf(binary: string): Promise<string | null> {
  try {
    await exec("/usr/bin/codesign", ["--verify", "--strict", binary]);
    // codesign prints the details on stderr.
    const { stderr } = await exec("/usr/bin/codesign", ["-dv", binary]);
    return /^TeamIdentifier=(\w+)$/m.exec(stderr)?.[1] ?? null;
  } catch {
    return null;
  }
}

const version = (tag: string): string => tag.replace(/^v/, "");

export class Addons {
  private readonly busy = new Map<AddonId, { controller: AbortController; status: AddonStatus; done: Promise<AddonStatus> }>();
  private readonly failed = new Map<AddonId, AddonFailure>();

  constructor(private readonly opts: AddonsOptions) {}

  private get catalog(): readonly AddonSource[] {
    return this.opts.catalog ?? ADDONS;
  }

  private source(id: AddonId): AddonSource {
    const found = this.catalog.find((a) => a.id === id);
    if (!found) throw new Error(`No add-on called ${id}.`);
    return found;
  }

  private home(id: AddonId): string {
    return join(this.opts.dir, id);
  }

  /** The program of the pinned version, when it is installed. */
  binary(id: AddonId): string | null {
    const src = this.catalog.find((a) => a.id === id);
    if (!src || this.busy.has(id)) return null;
    const path = join(this.home(id), src.tag, src.folder, src.binary);
    return existsSync(path) ? path : null;
  }

  /** The folder the pinned version's program runs from. */
  engineDir(id: AddonId): string {
    return join(this.home(id), this.source(id).tag);
  }

  status(id: AddonId): AddonStatus {
    const src = this.source(id);
    const running = this.busy.get(id);
    if (running) return running.status;
    if (this.binary(id)) return { state: "ready", version: version(src.tag) };
    const failure = this.failed.get(id);
    const from = this.installed(id).map(version)[0];
    if (failure) return { state: "failed", reason: failure, ...(from && { from }) };
    const older = this.installed(id).find((tag) => tag !== src.tag);
    return older ? { state: "outdated", version: version(older) } : { state: "absent" };
  }

  /** An earlier version is on this Mac but the pinned one is not ready yet: an update is due or under way. */
  updating(id: AddonId): boolean {
    return this.binary(id) === null && this.installed(id).length > 0;
  }

  /**
   * Brings every add-on the user installed up to the version this Vunemi
   * pins, one after another. Called when Vunemi opens, so an add-on is
   * updated together with Vunemi; one that fails is tried again on the next
   * opening, and the Update button stays for the user meanwhile.
   */
  async updateOutdated(): Promise<void> {
    for (const src of this.catalog) {
      if (this.status(src.id).state === "outdated") await this.install(src.id);
    }
  }

  list(): AddonEntry[] {
    return this.catalog.map((a) => ({
      id: a.id,
      category: a.category,
      engine: a.engine,
      publisher: a.publisher,
      licence: a.licence,
      version: version(a.tag),
      bytes: a.size,
      source: `https://github.com/${a.repo}`,
      status: this.status(a.id),
    }));
  }

  /** Version folders that are whole: the ones being unpacked start with a dot. */
  private installed(id: AddonId): string[] {
    try {
      return readdirSync(this.home(id)).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
  }

  /** Downloads and installs the pinned version; a second call joins the first. */
  install(id: AddonId): Promise<AddonStatus> {
    const src = this.source(id);
    const running = this.busy.get(id);
    if (running) return running.done;
    if (this.binary(id)) return Promise.resolve(this.status(id));

    this.failed.delete(id);
    const from = this.installed(id).map(version)[0];
    const controller = new AbortController();
    const state = { controller, status: { state: "downloading", received: 0, ...(from && { from }) } as AddonStatus, done: Promise.resolve(this.status(id)) };
    const say = (status: AddonStatus): void => {
      state.status = status;
      this.opts.onChange?.(id, status);
    };
    this.busy.set(id, state);
    state.done = this.fetch(src, controller.signal, say, from)
      .then(
        () => undefined,
        (err: unknown) => {
          const code = err instanceof DownloadError ? err.code : err instanceof InstallError ? err.reason : "unpack";
          if (code !== "cancelled") this.failed.set(id, code);
        },
      )
      .then(() => {
        this.busy.delete(id);
        const status = this.status(id);
        this.opts.onChange?.(id, status);
        return status;
      });
    this.opts.onChange?.(id, state.status);
    return state.done;
  }

  private async fetch(src: AddonSource, signal: AbortSignal, say: (status: AddonStatus) => void, from?: string): Promise<void> {
    const incoming = join(this.opts.dir, ".incoming");
    const staging = join(this.home(src.id), `.${src.tag}`);
    const zip = await (this.opts.download ?? downloadPinned)(
      { url: addonUrl(src), name: src.file, size: src.size, sha256: src.sha256 },
      incoming,
      { signal, allowUrl: allowedAddonUrl, onProgress: (p) => say({ state: "downloading", received: p.received, ...(from && { from }) }) },
    );
    say({ state: "installing", ...(from && { from }) });
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await (this.opts.unpack ?? ditto)(zip, staging);
      const binary = join(staging, src.folder, src.binary);
      if (!existsSync(binary)) throw new InstallError("unpack");
      if ((await (this.opts.signedBy ?? teamOf)(binary)) !== ADDON_TEAM) throw new InstallError("signature");
      // Earlier versions go first: the folder then holds this version and nothing else.
      for (const old of this.installed(src.id)) rmSync(join(this.home(src.id), old), { recursive: true, force: true });
      renameSync(staging, join(this.home(src.id), src.tag));
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      // Nothing of a refused add-on stays, not even its empty folder.
      if (this.installed(src.id).length === 0) rmSync(this.home(src.id), { recursive: true, force: true });
      throw err instanceof InstallError ? err : new InstallError("unpack");
    } finally {
      rmSync(zip, { force: true });
    }
  }

  cancel(id: AddonId): void {
    this.busy.get(id)?.controller.abort();
  }

  /** Moves the add-on to the Trash; the user can put it back or install it again. */
  async remove(id: AddonId): Promise<AddonStatus> {
    this.source(id);
    this.cancel(id);
    await this.busy.get(id)?.done;
    this.failed.delete(id);
    if (existsSync(this.home(id))) await this.opts.trash(this.home(id));
    const status = this.status(id);
    this.opts.onChange?.(id, status);
    return status;
  }
}

class InstallError extends Error {
  constructor(readonly reason: "signature" | "unpack") {
    super(reason);
  }
}
