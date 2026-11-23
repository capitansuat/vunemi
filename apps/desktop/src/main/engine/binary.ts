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
export function engineBinary(opts: { packaged: boolean; resourcesPath: string; home: string; system?: NodeJS.Platform }): string | null {
  // Windows runs programs by their .exe name.
  const name = (opts.system ?? process.platform) === "win32" ? "llama-server.exe" : "llama-server";
  const path = opts.packaged
    ? join(opts.resourcesPath, name)
    : join(opts.home, ".vunemi-build", "engine-cache", ENGINE_TAG, name);
  return existsSync(path) ? path : null;
}
