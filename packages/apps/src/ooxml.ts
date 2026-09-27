/**
 * Reads Office Open XML files (.pptx, .xlsx) straight from disk, so reading
 * needs neither the Office app, its Automation permission nor its file lock.
 * A small zip reader: central directory, stored or deflated entries, bounded
 * sizes. No zip64, no encrypted entries; such files are refused.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const MAX_ARCHIVE = 200 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_SLIDES = 100;

interface Entry {
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buffer.subarray(0, done);
}

/** Opens a zip archive and returns a reader for its text entries. */
export function readZip<T>(path: string, use: (text: (name: string) => string | null, names: string[]) => T): T {
  const fd = openSync(path, "r");
  try {
    const total = fstatSync(fd).size;
    if (total > MAX_ARCHIVE) throw new Error("The file is too large to read.");
    const tailLength = Math.min(total, 65_557);
    const tail = readAt(fd, total - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("The file is not a readable Office document (it may be protected).");
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirOffset === 0xffffffff || dirOffset + dirSize > total) throw new Error("The file's zip layout isn't supported.");
    const dir = readAt(fd, dirOffset, dirSize);
    const entries = new Map<string, Entry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) break;
      const flags = dir.readUInt16LE(p + 8);
      const nameLength = dir.readUInt16LE(p + 28);
      const name = dir.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      if (!(flags & 1)) {
        entries.set(name, {
          method: dir.readUInt16LE(p + 10),
          compressed: dir.readUInt32LE(p + 20),
          size: dir.readUInt32LE(p + 24),
          offset: dir.readUInt32LE(p + 42),
        });
      }
      p += 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    const text = (name: string): string | null => {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.size > MAX_ENTRY || entry.compressed > MAX_ENTRY) throw new Error("A part of the file is too large to read.");
      const local = readAt(fd, entry.offset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error("The file is damaged.");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = readAt(fd, start, entry.compressed);
      if (entry.method === 0) return data.toString("utf8");
      if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString("utf8");
      throw new Error("The file uses an unsupported compression.");
    };
    return use(text, [...entries.keys()]);
  } finally {
    closeSync(fd);
  }
}

/** Decodes the five XML entities and numeric references. */
export function xmlText(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const n = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

export function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? xmlText(match[1]!) : null;
}

/** Maps relationship ids to archive paths, resolved against `base` ("ppt/", "xl/"). */
export function relationships(xml: string | null, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [tag] of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (!id || !target || target.includes("..") || /^[a-z]+:/i.test(target)) continue;
    out.set(id, target.startsWith("/") ? target.slice(1) : base + target);
  }
  return out;
}

/** The text of each `<a:p>` paragraph, one line each. */
function paragraphs(xml: string): string[] {
  const lines: string[] = [];
  for (const [, body] of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const line = [...body!.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1]!)).join("");
    if (line.trim()) lines.push(line);
  }
  return lines;
}

export interface SlideText {
  number: number;
  text: string;
}

/** Slide text in presentation order, at most 100 slides. */
export function pptxOutline(path: string): { slides: SlideText[]; total: number; truncated: boolean } {
  return readZip(path, (text, names) => {
    const rels = relationships(text("ppt/_rels/presentation.xml.rels"), "ppt/");
    let order = [...(text("ppt/presentation.xml") ?? "").matchAll(/<p:sldId\b[^>]*>/g)]
      .map(([tag]) => rels.get(attr(tag, "r:id") ?? ""))
      .filter((name): name is string => !!name);
    if (order.length === 0) {
      order = names
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    }
    const slides = order.slice(0, MAX_SLIDES).map((name, i) => ({
      number: i + 1,
      text: paragraphs(text(name) ?? "").map((line) => line.slice(0, 1000)).join("\n").slice(0, 5000),
    }));
    return { slides, total: order.length, truncated: order.length > MAX_SLIDES };
  });
}

/** A cell as saved on disk: text, or null when the cell is empty or absent. */
export type DiskCell = string | null;

/** The workbook's sheet names, in order. */
export function xlsxSheets(path: string): string[] {
  return readZip(path, (text) =>
    [...(text("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].flatMap(([tag]) => {
      const name = attr(tag, "name");
      return name === null ? [] : [name];
    }),
  );
}

/** The archive path of a named worksheet; throws when there is none. */
export function sheetPart(text: (name: string) => string | null, sheet: string): string {
  const rels = relationships(text("xl/_rels/workbook.xml.rels"), "xl/");
  const tag = [...(text("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].map(([t]) => t).find((t) => attr(t, "name") === sheet);
  const part = tag ? rels.get(attr(tag, "r:id") ?? "") : undefined;
  if (!part) throw new Error(`The workbook has no worksheet named "${sheet}".`);
  return part;
}

/** Values as saved. Refs whose cell holds a formula are added to `formulas` when given. */
export function xlsxCells(
  path: string, sheet: string, refs: readonly string[], formulas?: Set<string>,
  /** Filled with each found cell's kind: n(umber), s(tring), b(oolean) or e(rror). */
  kinds?: Map<string, "n" | "s" | "b" | "e">,
  /** Filled with each found cell's style index, when it has one. */
  styles?: Map<string, number>,
): Record<string, DiskCell> {
  return readZip(path, (text) => {
    const part = sheetPart(text, sheet);
    const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(([, body]) =>
      [...body!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join(""),
    );
    const wanted = new Set(refs);
    const out: Record<string, DiskCell> = Object.fromEntries(refs.map((ref) => [ref, null]));
    for (const [, attrs, body] of (text(part) ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(` ${attrs}`, "r");
      if (!ref || !wanted.has(ref) || body === undefined) continue;
      const style = attr(` ${attrs}`, "s");
      if (styles && style !== null && /^\d+$/.test(style)) styles.set(ref, Number(style));
      if (formulas && /<f[\s>/]/.test(body)) formulas.add(ref);
      const type = attr(` ${attrs}`, "t");
      if (type === "inlineStr") {
        out[ref] = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join("");
        kinds?.set(ref, "s");
        continue;
      }
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (!v) continue;
      const raw = xmlText(v[1]!);
      kinds?.set(ref, type === "s" || type === "str" ? "s" : type === "b" ? "b" : type === "e" ? "e" : "n");
      out[ref] = type === "s" ? (shared[Number(raw)] ?? null) : type === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
    }
    return out;
  });
}

/** A cell as the model is shown it: dates as dates, numbers as numbers. */
export type SheetValue = string | number | boolean | null;

/** Number formats Excel builds in for dates and times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Whether a custom number format shows a date or time. */
export function isDateFormat(code: string): boolean {
  return /[dmyhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]|General/gi, ""));
}

/** Indexes into cellXfs whose number format is a date or time. */
function dateStyles(styles: string | null): Set<number> {
  const custom = new Map<number, string>();
  for (const [tag] of (styles ?? "").matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(tag, "numFmtId"));
    const code = attr(tag, "formatCode");
    if (Number.isInteger(id) && code !== null) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles ?? "")?.[1] ?? "";
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], i) => {
    const id = Number(attr(tag, "numFmtId") ?? "0");
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : DATE_FORMATS.has(id)) out.add(i);
  });
  return out;
}

/** An Excel date serial as ISO text: "2026-09-26", "2026-09-26 14:30", or "14:30" for a time alone. */
export function excelDate(serial: number, date1904 = false): string {
  if (!Number.isFinite(serial) || serial < 0) return String(serial);
  // The 1900 system counts a 29 February 1900 that never was; serials before it are a day off.
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const iso = new Date(Math.round((days - 25569) * 86_400_000)).toISOString();
  if (serial < 1) return iso.slice(11, 16);
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Cells of a saved workbook as the model should see them: numbers as
 * numbers, booleans as booleans, dates as ISO text, empty as "". With no
 * sheet, the first one.
 */
export function xlsxValues(path: string, sheet: string | null, refs: readonly string[]): { sheet: string; values: Record<string, SheetValue> } {
  const { name, dates, date1904 } = readZip(path, (text) => {
    const workbook = text("xl/workbook.xml") ?? "";
    const first = attr(/<sheet\b[^>]*>/.exec(workbook)?.[0] ?? "", "name");
    return {
      name: sheet ?? first,
      dates: dateStyles(text("xl/styles.xml")),
      date1904: /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook),
    };
  });
  if (name === null) throw new Error("The workbook has no worksheets.");
  const kinds = new Map<string, "n" | "s" | "b" | "e">();
  const styles = new Map<string, number>();
  const raw = xlsxCells(path, name, refs, undefined, kinds, styles);
  const values: Record<string, SheetValue> = {};
  for (const ref of refs) {
    const cell = raw[ref] ?? null;
    const kind = kinds.get(ref);
    if (cell === null) values[ref] = "";
    else if (kind === "n" && Number.isFinite(Number(cell))) {
      values[ref] = dates.has(styles.get(ref) ?? -1) ? excelDate(Number(cell), date1904) : Number(cell);
    } else if (kind === "b") values[ref] = cell === "TRUE";
    else values[ref] = cell;
  }
  return { sheet: name, values };
}

/** The sheet's own record of the area it uses ("A1:D20"), when it keeps one. */
export function xlsxUsedRange(path: string, sheet: string | null): string | null {
  return readZip(path, (text) => {
    const name = sheet ?? attr(/<sheet\b[^>]*>/.exec(text("xl/workbook.xml") ?? "")?.[0] ?? "", "name");
    if (name === null) return null;
    const ref = /<dimension\b[^>]*\bref="([^"]+)"/.exec(text(sheetPart(text, name)) ?? "")?.[1];
    return ref ?? null;
  });
}
