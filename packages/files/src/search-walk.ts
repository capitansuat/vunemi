/**
 * files_search without Spotlight: a bounded walk of the open folders.
 *
 * Linux has no index every system can be assumed to have, so the folders
 * are walked: names are matched for every file, and the text inside is
 * matched for small plain-text files. It stops at a number of entries and
 * at a deadline, and says so, rather than reading a whole disk.
 *
 * Symbolic links are not followed, hidden entries are skipped (as Spotlight
 * results were), and every hit is still checked by Roots by the caller.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface WalkLimits {
  /** Entries looked at, files and folders together. */
  maxEntries: number;
  /** Matches collected before stopping. */
  maxFound: number;
  /** Files whose text is read are at most this large. */
  maxTextBytes: number;
  deadline: number;
  signal?: AbortSignal;
}

export const DEFAULT_WALK: Omit<WalkLimits, "deadline"> = { maxEntries: 50_000, maxFound: 2_000, maxTextBytes: 1024 * 1024 };

/** Files whose bytes are text, read for the words inside them. */
const TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".sh", ".yml", ".yaml", ".toml", ".ini", ".log", ".tex", ".srt", ".vtt", ".ics", ".vcf", ".eml", ".rtf", ".svg"]);

/** A query the way files_search takes it: words, or a kind of file such as "*.pdf". */
export function walkMatcher(words: string): { name: (name: string) => boolean; text: ((content: string) => boolean) | null } {
  const wanted = words.trim();
  const kind = /^\*?\.([a-z0-9]{1,8})$/i.exec(wanted);
  if (kind) {
    const ext = `.${kind[1]!.toLowerCase()}`;
    return { name: (name) => name.toLowerCase().endsWith(ext), text: null };
  }
  const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase();
  const needle = fold(wanted);
  return {
    name: (name) => fold(name).includes(needle),
    text: (content) => fold(content).includes(needle),
  };
}

export interface WalkResult {
  found: string[];
  /** The walk stopped before the end: too many entries, too many hits, or out of time. */
  cut: boolean;
}

export function walkSearch(places: string[], words: string, limits: WalkLimits): WalkResult {
  const match = walkMatcher(words);
  const found: string[] = [];
  let seen = 0;
  let cut = false;
  const queue = [...places];
  while (queue.length > 0) {
    if (limits.signal?.aborted) throw limits.signal.reason ?? new Error("aborted");
    if (found.length >= limits.maxFound || seen >= limits.maxEntries || Date.now() > limits.deadline) {
      cut = true;
      break;
    }
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > limits.maxEntries) {
        cut = true;
        break;
      }
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (match.name(entry.name) || (match.text && TEXT.has(extname(entry.name).toLowerCase()) && contains(path, match.text, limits.maxTextBytes))) {
        found.push(path);
        if (found.length >= limits.maxFound) {
          cut = true;
          break;
        }
      }
    }
  }
  return { found, cut };
}

function contains(path: string, test: (content: string) => boolean, max: number): boolean {
  let fd: number | null = null;
  try {
    if (statSync(path).size > max) return false;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(max);
    const length = readSync(fd, buffer, 0, max, 0);
    const bytes = buffer.subarray(0, length);
    if (bytes.subarray(0, 8192).includes(0)) return false;
    return test(bytes.toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
