import { existsSync } from "node:fs";
import { join } from "node:path";

/** The llama.cpp release the engine is built from; scripts/build-engine.sh must agree. */
export const ENGINE_TAG = "v0.5.0";

/**
 * The installed app carries the engine in its resources; a development run
 * uses the one scripts/build-engine.sh left in the build cache. Without
 * either, the built-in engine is simply unavailable and everything else
 * still works.
 */
export function engineBinary(opts: { packaged: boolean; resourcesPath: string; home: string }): string | null {
  const path = opts.packaged
    ? join(opts.resourcesPath, "llama-server")
    : join(opts.home, ".ocak-build", "engine-cache", ENGINE_TAG, "llama-server");
  return existsSync(path) ? path : null;
}
