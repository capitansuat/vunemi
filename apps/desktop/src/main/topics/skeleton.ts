/**
 * The skeleton of a linked folder, made by code with no model: each file's
 * headings, the links between its files, and the codes they use (QXA, BR,
 * R_2WK_4X). Codes are a domain's own names for things, so "where is QXA
 * defined" becomes a lookup instead of a guess
 * (tenami/docs/superpowers/specs/2026-11-22-topic-wiki-design.md, section 2).
 *
 * Everything here reads file text, which is untrusted: it only collects
 * strings, and whatever shows them to the model fences them as data.
 */
import { posix } from "node:path";

/** Headings kept per file. */
const OUTLINE_MAX = 12;
/** Codes kept per file, the most used first. */
const CODES_MAX = 200;

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;
/** Capitals, digits and underscores, 2 to 20 long, not inside a longer word. */
const CODE = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9_]{1,19}(?![\p{L}\p{N}_])/gu;

/** Capital words that are not a domain's codes. */
export const CODE_STOP: ReadonlySet<string> = new Set([
  "THE", "AND", "FOR", "NOT", "BUT", "ARE", "ALL", "ANY", "YOU", "CAN", "WITH", "FROM", "THIS", "THAT",
  "OR", "IF", "IS", "IT", "IN", "ON", "OF", "TO", "AN", "AS", "AT", "BY", "BE", "NO", "YES",
  "PDF", "HTML", "HTM", "CSV", "JSON", "XML", "TXT", "MD", "PNG", "JPG", "JPEG", "SVG",
  "URL", "URI", "HTTP", "HTTPS", "WWW", "API", "ID", "IDS", "OK", "NA", "TBD", "TODO", "NOTE", "FAQ",
  "AM", "PM", "UTC", "GMT", "UTF",
]);

/** The headings of a Markdown text, in order. */
export function outlineOf(markdown: string, max = OUTLINE_MAX): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = HEADING.exec(line);
    if (!m?.[1]?.trim()) continue;
    out.push(m[1].trim().slice(0, 200));
    if (out.length >= max) break;
  }
  return out;
}

const LINK = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)|href\s*=\s*["']([^"'\n]+)["']|\[\[([^\]\n]+?)\]\]/gi;

/**
 * Where a text links to, in order and once each: Markdown links, HTML
 * hrefs and [[wiki links]]. Links to the web, mail and anchors in the same
 * file are left out; what follows # or ? is dropped.
 */
export function linksOf(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(LINK)) {
    let target = (m[1] ?? m[2] ?? m[3]!.split("|")[0]!).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    target = target.replace(/[#?].*$/s, "");
    try {
      target = decodeURIComponent(target);
    } catch {
      // Not encoded after all: kept as it is.
    }
    if (target) out.add(target);
  }
  return [...out];
}

const stemOf = (rel: string): string => {
  const ext = posix.extname(rel);
  return ext ? rel.slice(0, -ext.length) : rel;
};
const stems = new WeakMap<ReadonlySet<string>, Map<string, string>>();

/**
 * A link from one file of a folder to another: relative to the file's own
 * place, the path as written or the same name in another kind (a link to
 * x.html reaches x.md, the one file kept for that document). Null when it
 * leads nowhere in the folder, or out of it.
 */
export function resolveLink(fromRel: string, target: string, rels: ReadonlySet<string>): string | null {
  const joined = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(fromRel), target));
  if (joined === ".." || joined.startsWith("../") || joined === ".") return null;
  if (rels.has(joined)) return joined;
  let byStem = stems.get(rels);
  if (!byStem) {
    byStem = new Map();
    for (const rel of rels) if (!byStem.has(stemOf(rel))) byStem.set(stemOf(rel), rel);
    stems.set(rels, byStem);
  }
  return byStem.get(joined) ?? byStem.get(stemOf(joined)) ?? null;
}

export interface CodeUse {
  code: string;
  count: number;
  /** In a heading or the first two cells of a table row: where a code is usually defined. */
  defined: boolean;
}

/** Where a table row's first two cells end: its third bar, else the line's end. */
function keyCellsEnd(line: string): number {
  let bars = 0;
  for (let i = 0; i < line.length; i++) if (line[i] === "|" && ++bars === 3) return i;
  return line.length;
}

/** The codes a text uses, the most used first, at most CODES_MAX. */
export function codesOf(markdown: string): CodeUse[] {
  const found = new Map<string, CodeUse>();
  for (const line of markdown.split("\n")) {
    const heading = HEADING.test(line);
    // A table row's first two cells: "| QXB | Short loan |" and "| BR | QXA | Central |"
    // define QXB and QXA; a reference table often keys by a group, then the code.
    const keyCells = line.trimStart().startsWith("|") ? keyCellsEnd(line) : -1;
    for (const m of line.matchAll(CODE)) {
      const code = m[0];
      if (CODE_STOP.has(code)) continue;
      const use = found.get(code) ?? { code, count: 0, defined: false };
      use.count++;
      if (heading || m.index! < keyCells) use.defined = true;
      found.set(code, use);
    }
  }
  // Sorted by count; a Map keeps the first appearance for equal counts.
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, CODES_MAX);
}
