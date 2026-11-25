import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * esbuild's command line, as the process tests call it to bundle a worker.
 * On macOS and Linux its bin is the native program; on Windows the bin is a
 * Node script (with a .cmd shim Node won't start without a shell), so it is
 * run with Node itself.
 */
export function esbuild(args: string[]): void {
  const modules = resolve("../../packages/mac/node_modules");
  if (process.platform === "win32") execFileSync(process.execPath, [resolve(modules, "esbuild/bin/esbuild"), ...args], { stdio: "pipe" });
  else execFileSync(resolve(modules, ".bin/esbuild"), args, { stdio: "pipe" });
}
