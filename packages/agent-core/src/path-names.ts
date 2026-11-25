/**
 * File names and `~` paths as the agent compares them, written with either
 * separator: Windows paths use `\`, and models write `/` everywhere. No
 * node:path, because the window bundles this package too.
 */

/** The last part of a path: its file or folder name. */
export function baseNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Whether `tilde` (a path starting with ~/ or ~\) names `full`, a real path. */
export function tildeMatches(tilde: string, full: string): boolean {
  if (!/^~[\\/]/.test(tilde)) return false;
  return full.replace(/\\/g, "/").endsWith(tilde.slice(1).replace(/\\/g, "/"));
}
