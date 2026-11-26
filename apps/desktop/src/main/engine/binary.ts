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
 * their .exe name. One Windows machine, and one arm64 Linux machine, builds
 * both architectures, so their caches have a folder per architecture
 * (scripts/windows/build-*.ps1, scripts/build-*-linux.sh).
 */
export function builtBinary(opts: BinaryLookup, program: string, cacheName: string, tag: string): string | null {
  const system = opts.system ?? process.platform;
  const windows = system === "win32";
  const name = windows ? `${program}.exe` : program;
  const arch = opts.arch ?? process.arch;
  const folder = windows ? `${tag}-win-${arch}` : system === "linux" ? `${tag}-linux-${arch}` : tag;
  const path = opts.packaged ? join(opts.resourcesPath, name) : join(opts.home, ".vunemi-build", cacheName, folder, name);
  return existsSync(path) ? path : null;
}
