/**
 * Writes plain values into a saved .xlsx without Excel, so a Mac with no
 * Office, no licence or another spreadsheet app can still be helped.
 *
 * Only the worksheet written to is rebuilt (and the workbook part, to ask
 * for recalculation on opening); every other part of the archive is copied
 * byte for byte. The new file is written beside the old one and moved into
 * place, so a failure leaves the original as it was.
 */

import { existsSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { attr, sheetPart } from "./ooxml.js";

const MAX_FILE = 100 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const UNSUPPORTED = "This workbook's file layout isn't supported for writing without Excel.";
const DAMAGED = "The workbook file is damaged.";

export type CellValue = string | number | boolean | null;

interface ZipEntry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  size: number;
  data: Buffer;
  internal: number;
  external: number;
  madeBy: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("The file is not a readable Office document (it may be protected).");
  const count = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 4) !== 0 || count === 0xffff || dirOffset === 0xffffffff || dirOffset + dirSize > zip.length) throw new Error(UNSUPPORTED);
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error(DAMAGED);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    if (flags & 1) throw new Error("The workbook is encrypted; it can't be written without Excel.");
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || (method !== 0 && method !== 8)) throw new Error(UNSUPPORTED);
    if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(DAMAGED);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (start + compressed > zip.length) throw new Error(DAMAGED);
    const nameBytes = Buffer.from(zip.subarray(p + 46, p + 46 + nameLength));
    entries.push({
      name: nameBytes.toString("utf8"), nameBytes, flags, method,
      time: zip.readUInt16LE(p + 12), date: zip.readUInt16LE(p + 14), crc: zip.readUInt32LE(p + 16), size,
      data: zip.subarray(start, start + compressed),
      internal: zip.readUInt16LE(p + 36), external: zip.readUInt32LE(p + 38), madeBy: zip.readUInt16LE(p + 4),
    });
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

function entryText(entry: ZipEntry): string {
  if (entry.size > MAX_PART) throw new Error("A part of the workbook is too large to write.");
  return (entry.method === 0 ? entry.data : inflateRawSync(entry.data, { maxOutputLength: MAX_PART })).toString("utf8");
}

function dosNow(): { time: number; date: number } {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function withText(entry: ZipEntry, text: string): ZipEntry {
  const raw = Buffer.from(text, "utf8");
  return { ...entry, ...dosNow(), method: 8, crc: crc32(raw), size: raw.length, data: deflateRawSync(raw) };
}

function writeEntries(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    // Sizes and CRC go in the local header, so no data descriptor follows.
    const flags = e.flags & ~0x0008;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(e.nameBytes.length, 26);
    parts.push(local, e.nameBytes, e.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(e.madeBy, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(e.method, 10);
    entry.writeUInt16LE(e.time, 12);
    entry.writeUInt16LE(e.date, 14);
    entry.writeUInt32LE(e.crc, 16);
    entry.writeUInt32LE(e.data.length, 20);
    entry.writeUInt32LE(e.size, 24);
    entry.writeUInt16LE(e.nameBytes.length, 28);
    entry.writeUInt16LE(e.internal, 36);
    entry.writeUInt32LE(e.external, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, e.nameBytes);
    offset += 30 + e.nameBytes.length + e.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + dir.length > 0xffffffff) throw new Error(UNSUPPORTED);
  return Buffer.concat([...parts, dir, end]);
}

function columnIndex(letters: string): number {
  return [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
}

function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function parseRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(ref);
  return match ? { col: columnIndex(match[1]!), row: Number(match[2]) } : null;
}

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A cell element for one written value, keeping the cell's style. */
function cellXml(ref: string, style: string, value: CellValue): string {
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number") return `<c r="${ref}"${s}><v>${Object.is(value, -0) ? 0 : value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (INVALID_XML.test(value)) throw new Error("Cell text contains characters a workbook can't hold.");
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeText(value)}</t></is></c>`;
}

interface Cell { col: number; text: string }
interface Row { r: number; attrs: string; cells: Cell[]; rest: string; text: string; touched: boolean }

export interface SheetEdit {
  xml: string;
  /** Written cells that held a formula of their own. */
  formulas: string[];
  /** Written cells that hold a formula other cells share or spill from. */
  anchors: string[];
}

/** Sets cells in a worksheet's XML. Leaves every row it doesn't write to exactly as it was. */
export function setCells(xml: string, start: { row: number; col: number }, values: CellValue[][]): SheetEdit {
  const data = /<sheetData\b[^>]*\/>|<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
  if (!data) throw new Error(UNSUPPORTED);
  const rows: Row[] = [];
  const body = data[1] ?? "";
  const leftover = body.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (text, attrs: string, inner: string | undefined) => {
    const r = Number(attr(` ${attrs}`, "r"));
    if (!Number.isInteger(r) || r < 1) throw new Error(UNSUPPORTED);
    const cells: Cell[] = [];
    const rest = (inner ?? "").replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (cellText, cellAttrs: string) => {
      const ref = parseRef(attr(` ${cellAttrs}`, "r") ?? "");
      if (!ref || ref.row !== r) throw new Error(UNSUPPORTED);
      cells.push({ col: ref.col, text: cellText });
      return "";
    });
    rows.push({ r, attrs, cells, rest: rest.trim(), text, touched: false });
    return "";
  });
  if (leftover.trim()) throw new Error(UNSUPPORTED);
  const hadCells = rows.some((row) => row.cells.length > 0);

  const formulas: string[] = [];
  const anchors: string[] = [];
  values.forEach((line, i) => {
    const r = start.row + i;
    let row = rows.find((candidate) => candidate.r === r);
    if (!row) {
      row = { r, attrs: ` r="${r}"`, cells: [], rest: "", text: "", touched: true };
      rows.push(row);
    }
    row.touched = true;
    line.forEach((value, j) => {
      const col = start.col + j;
      const ref = `${columnName(col)}${r}`;
      const at = row!.cells.findIndex((cell) => cell.col === col);
      const old = at >= 0 ? row!.cells[at]!.text : "";
      if (/<f\b[^>]*\bref="/.test(old)) anchors.push(ref);
      else if (/<f[\s>/]/.test(old)) formulas.push(ref);
      const style = /^<c\b[^>]*?\ss="(\d+)"/.exec(old)?.[1] ?? "";
      const cell = { col, text: cellXml(ref, style, value) };
      if (at >= 0) row!.cells[at] = cell;
      else row!.cells.push(cell);
    });
  });

  rows.sort((a, b) => a.r - b.r);
  const rebuilt = rows.map((row) => {
    if (!row.touched) return row.text;
    row.cells.sort((a, b) => a.col - b.col);
    // "spans" is only a hint about the row's width; stale, it is worse than none.
    const attrs = row.attrs.replace(/\sspans="[^"]*"/, "");
    const inner = row.cells.map((cell) => cell.text).join("") + row.rest;
    return inner ? `<row${attrs}>${inner}</row>` : `<row${attrs}/>`;
  }).join("");
  const open = /^<sheetData\b[^>]*?(?=\/?>)/.exec(data[0])![0];
  let out = xml.slice(0, data.index) + `${open}>${rebuilt}</sheetData>` + xml.slice(data.index + data[0].length);

  // The sheet's record of the area it uses, grown to cover what was written.
  const dimension = /<dimension\b[^>]*\bref="([^"]*)"[^>]*\/>/.exec(out);
  if (dimension) {
    const [first, last] = dimension[1]!.split(":");
    const a = parseRef(first ?? "");
    const b = parseRef(last ?? first ?? "");
    const endRow = start.row + values.length - 1;
    const endCol = start.col + (values[0]?.length ?? 1) - 1;
    const empty = !a || !b || !hadCells;
    const top = empty ? start.row : Math.min(a.row, start.row);
    const left = empty ? start.col : Math.min(a.col, start.col);
    const bottom = empty ? endRow : Math.max(b.row, endRow);
    const right = empty ? endCol : Math.max(b.col, endCol);
    const ref = top === bottom && left === right ? `${columnName(left)}${top}` : `${columnName(left)}${top}:${columnName(right)}${bottom}`;
    out = out.replace(dimension[0], dimension[0].replace(/ref="[^"]*"/, `ref="${ref}"`));
  }
  return { xml: out, formulas, anchors };
}

/**
 * Asks the spreadsheet app to recalculate everything when the file is next
 * opened: formulas that read a written cell still hold their old results.
 */
export function recalcOnOpen(xml: string): string {
  const calc = /<calcPr\b[^>]*?\/?>/.exec(xml);
  if (calc) {
    const tag = /\sfullCalcOnLoad="[^"]*"/.test(calc[0])
      ? calc[0].replace(/\sfullCalcOnLoad="[^"]*"/, ' fullCalcOnLoad="1"')
      : calc[0].replace(/^<calcPr/, '<calcPr fullCalcOnLoad="1"');
    return xml.replace(calc[0], tag);
  }
  // calcPr follows these in the schema's order.
  for (const close of ["</definedNames>", "</externalReferences>", "</functionGroups>", "</sheets>"]) {
    const at = xml.lastIndexOf(close);
    if (at >= 0) return `${xml.slice(0, at + close.length)}<calcPr fullCalcOnLoad="1"/>${xml.slice(at + close.length)}`;
  }
  return xml;
}

/** The app whose lock file says it has this workbook open, if any. */
export function lockedBy(path: string): string | null {
  const dir = dirname(path);
  const name = basename(path);
  if (existsSync(join(dir, `~$${name}`))) return "Microsoft Excel";
  if (existsSync(join(dir, `.~lock.${name}#`))) return "LibreOffice";
  return null;
}

export interface XlsxWriteOptions {
  /** Only when the user asked to overwrite cells that hold formulas. */
  replaceFormulas?: boolean;
}

/**
 * Writes a rectangle of values into one sheet of a saved workbook.
 * Throws, writing nothing, when a cell holds a formula (unless
 * `replaceFormulas`) or a formula other cells depend on (always).
 */
export function xlsxWrite(path: string, sheet: string, start: { row: number; col: number }, values: CellValue[][], opts: XlsxWriteOptions = {}): { formulas: string[] } {
  const before = statSync(path);
  if (before.size > MAX_FILE) throw new Error("The workbook is too large to write without Excel.");
  const zip = readFileSync(path);
  const entries = readEntries(zip);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const text = (name: string): string | null => {
    const entry = byName.get(name);
    return entry ? entryText(entry) : null;
  };
  const part = sheetPart(text, sheet);
  const edit = setCells(text(part) ?? "", start, values);
  if (edit.anchors.length > 0) {
    throw new Error(`Nothing was written: ${edit.anchors.slice(0, 10).join(", ")} ${edit.anchors.length === 1 ? "holds a formula that other cells share" : "hold formulas that other cells share"}; overwriting would break them. Ask the user to change it in their spreadsheet app.`);
  }
  if (edit.formulas.length > 0 && opts.replaceFormulas !== true) {
    throw new Error(`Nothing was written: ${edit.formulas.slice(0, 10).join(", ")} ${edit.formulas.length === 1 ? "holds a formula" : "hold formulas"}, and writing there replaces ${edit.formulas.length === 1 ? "it" : "them"} with plain values. Ask the user; only if they want that, call again with replaceFormulas=true.`);
  }
  const workbook = recalcOnOpen(text("xl/workbook.xml") ?? "");
  // A replaced formula would leave the calculation chain pointing at a plain value, which Excel calls damage.
  const dropChain = edit.formulas.length > 0;
  const next: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.name === part) next.push(withText(entry, edit.xml));
    else if (entry.name === "xl/workbook.xml") next.push(withText(entry, workbook));
    else if (dropChain && entry.name === "xl/calcChain.xml") continue;
    else if (dropChain && entry.name === "[Content_Types].xml") next.push(withText(entry, entryText(entry).replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "")));
    else if (dropChain && entry.name === "xl/_rels/workbook.xml.rels") next.push(withText(entry, entryText(entry).replace(/<Relationship\b[^>]*Target="\/?(?:xl\/)?calcChain\.xml"[^>]*\/>/, "")));
    else next.push(entry);
  }
  const out = writeEntries(next);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.vunemi-tmp`);
  writeFileSync(temp, out, { mode: before.mode & 0o777 });
  try {
    const now = statSync(path);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) throw new Error("The workbook changed while it was being written; nothing was written. Try again.");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { formulas: edit.formulas };
}
