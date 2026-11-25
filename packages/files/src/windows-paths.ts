/**
 * Windows path rules that are plain string checks: the forms Windows reads
 * differently from how they are written. Each would let a name that passes
 * the open-folder check reach something else on disk — a network share, a
 * device, a hidden stream of a file, or a name Windows quietly changes — so
 * they are refused before the path is resolved. No node:path here, so the
 * rules are tested on every system.
 */

/** Device names Windows keeps in every folder, with or without an extension. */
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Why Windows would not open this path as written, or null. `path` is the
 * input after `~` is expanded and with `/` written as `\`.
 */
export function windowsPathProblem(path: string): "unsupported" | null {
  // \\server\share, \\?\C:\..., \\.\device: past the open-folder rules by design.
  if (path.startsWith("\\\\")) return "unsupported";
  let rest = path;
  const drive = /^[A-Za-z]:/.exec(path);
  if (drive) {
    rest = path.slice(2);
    // C:foo is relative to that drive's current folder, which nobody can see.
    if (!rest.startsWith("\\")) return "unsupported";
  }
  // Any other colon names a stream of a file (name:stream).
  if (rest.includes(":")) return "unsupported";
  for (const segment of rest.split("\\")) {
    if (!segment || segment === "." || segment === "..") continue;
    // Windows drops a trailing dot or space, so the name checked is not the one opened.
    if (segment.endsWith(".") || segment.endsWith(" ")) return "unsupported";
    if (DEVICE.test(segment.split(".")[0]!.trimEnd())) return "unsupported";
  }
  return null;
}

/**
 * Whether `path` is `root` or inside it. Windows compares names without regard
 * to letter case (NTFS does), so a path the model wrote as DOCUMENTS is inside
 * Documents there; elsewhere the comparison is exact, as it always was.
 */
export function within(path: string, root: string, system: NodeJS.Platform = process.platform): boolean {
  const sep = system === "win32" ? "\\" : "/";
  const [p, r] = system === "win32" ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return p === r || p.startsWith(r + sep);
}

/** The same folder: exact elsewhere, without regard to letter case on Windows. */
export function sameFolder(a: string, b: string, system: NodeJS.Platform = process.platform): boolean {
  return system === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
