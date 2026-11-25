import { existsSync } from "node:fs";
import { join } from "node:path";

/** The llama.cpp release the engine is built from; scripts/engine-version.sh must agree. */
export const ENGINE_TAG = "b12633";

/**
 * The installed app carries the engine in its resources; a development run
 * uses the one scripts/build-engine.sh left in the build cache. Without
 * either, the built-in engine is simply unavailable and everything else
 * still works.
 */
export function engineBinary(opts: BinaryLookup): string | null {
  return builtBinary(opts, "llama-server", "engine-cache", ENGINE_TAG);
}

export interface BinaryLookup {
  packaged: boolean;
  resourcesPath: string;
  home: string;
  system?: NodeJS.Platform;
  arch?: string;
}

/**
 * A program built from source next to the app: in its resources once
 * packaged, in the build cache during development. Windows runs programs by
 * their .exe name, and one Windows machine builds both architectures, so its
 * cache has a folder per architecture (scripts/windows/build-*.ps1).
 */
export function builtBinary(opts: BinaryLookup, program: string, cacheName: string, tag: string): string | null {
  const windows = (opts.system ?? process.platform) === "win32";
  const name = windows ? `${program}.exe` : program;
  const folder = windows ? `${tag}-win-${opts.arch ?? process.arch}` : tag;
  const path = opts.packaged ? join(opts.resourcesPath, name) : join(opts.home, ".vunemi-build", cacheName, folder, name);
  return existsSync(path) ? path : null;
}
