/** Narrow Office presets. All scripts are fixed; arguments travel only as JSON. */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, dirname, basename, join } from "node:path";
import type { ToolContext, ToolDef } from "@ocak/agent-core";
import type { Roots } from "@ocak/files";
import { t } from "@ocak/i18n";
import { AppScriptError, type ScriptRunner } from "./runner.js";
import { pptxOutline, xlsxCells, xlsxSheets, xlsxUsedRange, xlsxValues, type SheetValue } from "./ooxml.js";
import { lockedBy, xlsxWrite, type CellValue } from "./xlsx-write.js";

const WORD = "Microsoft Word";
const EXCEL = "Microsoft Excel";
const MAX_TEXT = 20_000;
const MAX_CELLS = 500;
/** Only ever asks a workbook already open; Excel may be busy with the user's own editing. */
const EXCEL_TIMEOUT_MS = 30_000;
const exec = promisify(execFile);

/** Finds a workbook Excel already has open at a POSIX path, so Vunemi never closes the user's own window. */
export const FIND_WORKBOOK = `
function openWorkbookAt(app, path) {
  var hfsSuffix = ":" + path.replace(/^\\//, "").replace(/\\//g, ":");
  var books = app.workbooks() || [];
  for (var i = 0; i < books.length; i++) {
    try {
      var fullName = String(books[i].fullName());
      if (fullName === path || fullName.endsWith(hfsSuffix)) return books[i];
    } catch (_) {}
  }
  return null;
}`;

/**
 * Works on a workbook the user already has open in Excel: their window, their
 * unsaved changes. Never starts Excel, never opens, closes or saves a
 * workbook; with no workbook open it says so and the file is used instead.
 */
export const EXCEL_LIVE = `
${FIND_WORKBOOK}
function grid(v) {
  if (!Array.isArray(v)) return [[v]];
  return v.map(function (row) { return Array.isArray(row) ? row : [row]; });
}
function column(n) {
  var s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function posix(fullName) {
  var name = String(fullName);
  if (name.charAt(0) === "/") return name;
  if (name.indexOf(":") < 0) return null;
  return "/" + name.split(":").slice(1).join("/");
}
function run(argv) {
  var step = "start";
  try {
    return JSON.stringify(live(JSON.parse(argv[0]), function (name) { step = name; }));
  } catch (e) {
    // Permission, time and a quit Excel keep their own numbers; anything else says which step Excel refused.
    if (e && (e.errorNumber === -1743 || e.errorNumber === -1712 || e.errorNumber === -600)) throw e;
    return JSON.stringify({ failed: step, reason: String((e && e.message) || e).slice(0, 200) });
  }
}
function live(a, at) {
  var app = Application(a.appPath);
  if (!app.running()) return { notOpen: true };
  at("workbooks");
  // Asked without catching: a refusal (no Automation permission) must not read as "nothing open".
  var books = app.workbooks() || [];
  if (books.length === 0) return { notOpen: true };
  at("workbook");
  var wb = a.path ? openWorkbookAt(app, a.path) : app.activeWorkbook();
  if (!wb) return { notOpen: true };
  at("sheets");
  var sheets = wb.worksheets().map(function (s) { return String(s.name()); });
  var sheetName;
  if (a.sheet) {
    if (sheets.indexOf(a.sheet) < 0) return { noSheet: true, sheets: sheets };
    sheetName = a.sheet;
  } else {
    at("active sheet");
    // "active sheet" answers for a window, not always for a workbook.
    var active = null;
    try { active = String(wb.activeSheet().name()); } catch (_) {}
    if (!active && !a.path) try { active = String(app.activeSheet().name()); } catch (_) {}
    sheetName = active && sheets.indexOf(active) >= 0 ? active : sheets[0];
  }
  // Always by the name already known, the way Excel answered reliably.
  var sheet = wb.worksheets.byName(sheetName);
  var address = a.range;
  var truncated = false;
  if (!address) {
    at("used range");
    try {
      var used = sheet.usedRange();
      var top = used.firstRowIndex(), left = used.firstColumnIndex();
      var rows = used.rows.length, allCols = used.columns.length;
      var cols = Math.min(allCols, a.maxCells);
      var keep = Math.max(1, Math.min(rows, Math.floor(a.maxCells / cols)));
      truncated = keep < rows || cols < allCols;
      address = column(left) + top + ":" + column(left + cols - 1) + (top + keep - 1);
    } catch (_) {
      address = "A1:T25";
      truncated = true;
    }
  }
  at("range " + address);
  var target = sheet.ranges.byName(address);
  at("workbook name");
  var bookName = null, bookPath = a.path || null;
  try { bookName = String(wb.name()); } catch (_) {}
  at("workbook path");
  try { bookPath = posix(wb.fullName()) || bookPath; } catch (_) {}
  var out = { workbook: bookName, path: bookPath, sheet: sheetName, range: address, truncated: truncated };
  if (a.write) {
    at("formulas");
    var formulas = grid(target.formula()).map(function (row) { return row.map(function (f) { return typeof f === "string" && f.charAt(0) === "="; }); });
    var any = formulas.some(function (row) { return row.some(Boolean); });
    if (any && !a.replaceFormulas) { out.formulas = formulas; return out; }
    at("values before");
    out.before = grid(target.value());
    out.replacedFormulas = any;
    at("write");
    var values = a.write.map(function (row) { return row.map(function (v) { return v === null ? "" : v; }); });
    target.value = values.length === 1 && values[0].length === 1 ? values[0][0] : values;
  }
  at("values");
  out.values = grid(target.value());
  return out;
}`;

type Area = { text: string; rows: number; cols: number; start: { row: number; col: number } };

interface LiveResult {
  /** The step Excel refused, and what it said. */
  failed?: string;
  reason?: string;
  notOpen?: boolean;
  noSheet?: boolean;
  sheets?: string[];
  workbook?: string;
  path?: string | null;
  sheet?: string;
  range?: string;
  truncated?: boolean;
  formulas?: boolean[][];
  before?: unknown[][];
  replacedFormulas?: boolean;
  values?: unknown[][];
}

function source(roots: Roots, input: unknown, extensions: readonly string[]): string {
  const path = roots.resolve(String(input ?? ""), "read");
  if (!extensions.includes(extname(path).toLowerCase())) throw new Error(`Expected ${extensions.join(" or ")} file.`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("The source file does not exist.");
  return path;
}

function pdfPath(roots: Roots, sourcePath: string, input: unknown): string {
  const requested = typeof input === "string" && input.trim() ? input : join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.pdf`);
  const path = roots.resolve(requested, "write");
  if (extname(path).toLowerCase() !== ".pdf") throw new Error(t("files.pathInvalid"));
  if (existsSync(path)) throw new Error(t("files.exists", { path }));
  return path;
}

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated]` : text;
}

function cellIndex(raw: string): { row: number; col: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/.exec(raw);
  if (!match) throw new Error("Use an A1-style range such as A1:C10.");
  const col = [...match[1]!].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
  return { row: Number(match[2]), col };
}

function range(raw: unknown, maxCells = MAX_CELLS): { text: string; rows: number; cols: number; start: { row: number; col: number } } {
  const text = String(raw ?? "").trim().toUpperCase();
  const [first, last, extra] = text.split(":");
  if (!first || extra) throw new Error("Use one A1-style cell or a rectangular range.");
  const start = cellIndex(first);
  const end = cellIndex(last ?? first);
  const rows = end.row - start.row + 1;
  const cols = end.col - start.col + 1;
  if (rows < 1 || cols < 1 || rows * cols > maxCells) throw new Error(`A range may contain at most ${MAX_CELLS} cells.`);
  return { text, rows, cols, start };
}

function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** True when the saved cell shows the value that was written. */
function sameCell(disk: string | null, wrote: string | number | boolean | null): boolean {
  if (wrote === null || wrote === "") return disk === null || disk === "";
  if (typeof wrote === "number") return disk !== null && Number(disk) === wrote;
  if (typeof wrote === "boolean") return disk === (wrote ? "TRUE" : "FALSE");
  return disk === wrote;
}

/**
 * The old cells as values that write back to the same thing, keeping numbers
 * and booleans as such. Null when one can't be: an error value, or text that
 * Excel would take for a formula.
 */
function restorable(
  before: Record<string, string | null>, kinds: Map<string, "n" | "s" | "b" | "e">, refs: string[], cols: number,
): (string | number | boolean | null)[][] | null {
  const flat: (string | number | boolean | null)[] = [];
  for (const ref of refs) {
    const raw = before[ref] ?? null;
    const kind = kinds.get(ref);
    if (raw === null) flat.push("");
    else if (kind === "e") return null;
    else if (kind === "b") flat.push(raw === "TRUE");
    else if (kind === "n" && Number.isFinite(Number(raw))) flat.push(Number(raw));
    else if (/^[\s]*[=+@-]/.test(raw)) return null;
    else flat.push(raw);
  }
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < flat.length; i += cols) rows.push(flat.slice(i, i + cols));
  return rows;
}

function refsOf(target: { rows: number; cols: number; start: { row: number; col: number } }): string[] {
  const refs: string[] = [];
  for (let r = 0; r < target.rows; r++) for (let c = 0; c < target.cols; c++) refs.push(`${columnName(target.start.col + c)}${target.start.row + r}`);
  return refs;
}

function formulaRefusal(cells: string[]): string {
  return `Nothing was written: ${cells.slice(0, 10).join(", ")} ${cells.length === 1 ? "holds a formula" : "hold formulas"}, and writing there replaces ${cells.length === 1 ? "it" : "them"} with plain values. Ask the user; only if they want that, call again with replaceFormulas=true.`;
}

/** True when Excel shows the value that was written. */
function sameLive(got: unknown, wrote: string | number | boolean | null): boolean {
  if (wrote === null || wrote === "") return got === "" || got === null || got === undefined;
  if (typeof wrote === "number") return Number(got) === wrote;
  if (typeof wrote === "boolean") return got === wrote;
  return String(got) === wrote;
}

/** What Excel held, as values that write back to the same thing; null when a date or formula-like text is among them. */
function liveRestorable(before: unknown[][], rows: number, cols: number): CellValue[][] | null {
  const out: CellValue[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: CellValue[] = [];
    for (let c = 0; c < cols; c++) {
      const v = before[r]?.[c];
      if (v === null || v === undefined || v === "") row.push("");
      else if (typeof v === "number" || typeof v === "boolean") row.push(v);
      else if (typeof v === "string" && !/^\d{4}-\d\d-\d\dT/.test(v) && !/^[\s]*[=+@-]/.test(v)) row.push(v);
      else return null;
    }
    out.push(row);
  }
  return out;
}

/** Puts old values back in the saved file, only over cells that still hold what was written. */
function undoInFile(path: string, sheet: string, target: { cols: number; start: { row: number; col: number } }, refs: string[], wrote: CellValue[][], old: CellValue[][]): void {
  const holder = lockedBy(path);
  if (holder && holder !== EXCEL) throw new Error(t("apps.error.alreadyOpen", { app: holder, name: basename(path) }));
  const now = xlsxCells(path, sheet, refs);
  const edited = refs.filter((ref, i) => !sameCell(now[ref] ?? null, wrote[Math.floor(i / target.cols)]![i % target.cols]!));
  if (edited.length > 0) throw new Error(t("apps.excel.undoChanged", { cells: edited.slice(0, 5).join(", ") }));
  xlsxWrite(path, sheet, target.start, old);
  const after = xlsxCells(path, sheet, refs);
  const missed = refs.filter((ref, i) => !sameCell(after[ref] ?? null, old[Math.floor(i / target.cols)]![i % target.cols]!));
  if (missed.length > 0) throw new Error(t("apps.error.notSaved", { app: "Vunemi", detail: missed.slice(0, 5).join(", ") }));
}

function values(input: unknown, rows: number, cols: number): (string | number | boolean | null)[][] {
  // A small model writes one cell as "x" or ["x"], and one row or column flat.
  let raw = input;
  if (!Array.isArray(raw)) raw = [[raw]];
  else if ((raw as unknown[]).every((v) => !Array.isArray(v))) raw = rows === 1 ? [raw] : cols === 1 ? (raw as unknown[]).map((v) => [v]) : raw;
  if (!Array.isArray(raw) || raw.length !== rows) throw new Error("Values must have one row per range row.");
  return raw.map((row) => {
    if (!Array.isArray(row) || row.length !== cols) throw new Error("Values must have one column per range column.");
    return row.map((value) => {
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.length <= 2_000 && !/^[\s]*[=+@-]/.test(value)) return value;
      throw new Error("Cell values must be short plain text, finite numbers, booleans, or null; formulas are unavailable.");
    });
  });
}

export const OFFICE_INSTRUCTIONS = `Using Office:
- word_read reads .docx text directly without opening Word; word_export_pdf converts a .docx to a new PDF in an isolated renderer. Complex layouts may differ from Word's own PDF.
- excel_read_range reads at most 500 cells. If the user has the workbook open in Excel, it reads that window, unsaved changes included; otherwise the saved file. When the user talks about "my spreadsheet" or "this Excel", call it with no path: it reads the workbook in front in Excel and says its path. Dates come back as ISO dates.
- excel_write_range writes a rectangular set of plain values and needs approval for every call. It cannot write formulas. Into a workbook open in Excel it writes in the open window and does not save: tell the user to save it. For the workbook in front in Excel, leave out path. Otherwise it changes the .xlsx file itself; Excel, Office or a licence is not needed.
- powerpoint_outline reads text on up to 100 slides straight from the .pptx file, without opening PowerPoint. PowerPoint files can only be read: there is no tool to export them to PDF or change them, so say so rather than trying app_command or the screen.
- If a write says the workbook is open in another app, ask the user to close it there. If a write times out, the result is unknown: read the range before trying again.
- These tools only accept files inside the user's allowed folders. They cannot enter document passwords or run macros. Never claim an export or save worked unless the tool confirms it.`;

export type PdfRenderer = (html: string, signal: AbortSignal) => Promise<Uint8Array>;

/** The words that mean a request is about a file of this kind, in any language. */
const WANTED: Record<string, RegExp> = {
  word: /\b(?:word|docx)\b/i,
  excel: /\b(?:excel|xlsx)\b/i,
  powerpoint: /\b(?:powerpoint|pptx|keynote)\b/i,
};

export function createOfficeTools(run: ScriptRunner, roots: Roots, catalog: { find(id: string): Promise<{ path: string }> }, renderPdf: PdfRenderer): ToolDef[] {
  const appPath = async (id: string): Promise<string> => (await catalog.find(id)).path;
  /** The workbook as it is open in Excel; notOpen when Excel isn't installed, running, or showing it. */
  const live = async (args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<LiveResult> => {
    let excel: string;
    try {
      excel = await appPath("com.microsoft.Excel");
    } catch {
      return { notOpen: true };
    }
    const result = (await run(EXCEL_LIVE, { maxCells: MAX_CELLS, ...args, app: EXCEL, appPath: excel }, { timeoutMs: EXCEL_TIMEOUT_MS, ...(signal && { signal }) })) as LiveResult;
    if (result?.failed) throw new AppScriptError(t("apps.error.failed", { app: EXCEL, detail: `${result.failed}: ${result.reason ?? ""}` }), null);
    return result;
  };

  /** Writes into the workbook in front in Excel (path null: never saved). */
  const writeOpen = async (path: string | null, name: string, sheet: string, target: Area, refs: string[], cells: CellValue[][], replaceFormulas: boolean, ctx: ToolContext): Promise<string> => {
    const open = await live({ path, sheet, range: target.text, write: cells, replaceFormulas }, ctx.signal);
    if (open.noSheet) throw new Error(t("apps.error.noSheet", { sheet, sheets: (open.sheets ?? []).join(", ") }));
    if (open.formulas) throw new Error(formulaRefusal(refs.filter((_, i) => open.formulas![Math.floor(i / target.cols)]?.[i % target.cols])));
    if (open.notOpen) throw new Error(t("apps.error.noWorkbook"));
    return reportOpen(open, path, sheet, target, refs, cells, t("apps.excel.undo", { range: `${sheet}!${target.text}`, name: path ? basename(path) : name }), ctx);
  };

  /** Checks what Excel shows after a write, offers the undo there, and says what happened. */
  const reportOpen = (open: LiveResult, path: string | null, sheet: string, target: Area, refs: string[], cells: CellValue[][], label: string, ctx: ToolContext): string => {
    const at = (grid: unknown[][] | undefined, i: number) => grid?.[Math.floor(i / target.cols)]?.[i % target.cols];
    const wrong = refs.filter((_, i) => !sameLive(at(open.values, i), cells[Math.floor(i / target.cols)]![i % target.cols]!));
    if (wrong.length > 0) throw new Error(t("apps.error.notTaken", { app: EXCEL, detail: wrong.slice(0, 5).join(", ") }));
    const old = !open.replacedFormulas && open.before ? liveRestorable(open.before, target.rows, target.cols) : null;
    if (old) {
      ctx.offerUndo(label, async () => {
        const now = await live({ path, sheet, range: target.text }, undefined);
        if (now.notOpen) {
          if (!path) throw new Error(t("apps.error.noWorkbook"));
          return undoInFile(path, sheet, target, refs, cells, old);
        }
        const edited = refs.filter((_, i) => !sameLive(at(now.values, i), cells[Math.floor(i / target.cols)]![i % target.cols]!));
        if (edited.length > 0) throw new Error(t("apps.excel.undoChanged", { cells: edited.slice(0, 5).join(", ") }));
        await live({ path, sheet, range: target.text, write: old }, undefined);
      });
    }
    const replaced = refs.filter((_, i) => { const v = at(open.before, i); return v !== "" && v !== null && v !== undefined; });
    return [
      `Written into ${open.workbook ?? (path ? basename(path) : "the workbook")}, which is open in Excel: ${sheet}!${target.text} now shows the new values. Not saved yet: tell the user to save it in Excel if they want to keep it.`,
      replaced.length > 0 ? `Replaced: ${replaced.slice(0, 10).map((ref) => `${ref} "${String(at(open.before, refs.indexOf(ref))).slice(0, 40)}"`).join(", ")}.` : "",
      open.replacedFormulas ? "As the user asked, formulas in the range were replaced with plain values. This can't be undone from here." : "",
    ].filter(Boolean).join("\n");
  };
  const tools: ToolDef[] = [
    {
      name: "word_read", description: "Read text from a Word .docx file in an allowed folder.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      actionClass: "read", alwaysAsk: true, allowSessionApproval: true, approvalScope: () => "mac-app:microsoft-word", untrustedOutput: true,
      preview: async (a) => t("connectors.apps.requestPreview", { app: `Word: ${String(a.path ?? "")}` }),
      async run(a, ctx) {
        const path = source(roots, a.path, [".docx"]);
        try {
          const { stdout } = await exec("/usr/bin/textutil", ["-convert", "txt", "-stdout", path], {
            timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal: ctx.signal,
          });
          return `# ${basename(path)}\n${bounded(stdout)}`;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          const reason = String((error as { stderr?: string }).stderr || (error as Error).message).trim().slice(0, 200);
          throw new Error(t("files.unreadable", { name: basename(path), reason }));
        }
      },
    },
    {
      name: "word_export_pdf", description: "Export an allowed Word document to a new PDF in an allowed folder. Never overwrites an existing PDF.",
      parameters: { type: "object", properties: { path: { type: "string" }, out: { type: "string" } }, required: ["path"] },
      actionClass: "write-local", alwaysAsk: true,
      preview: async (a) => t("connectors.apps.commandPreview", { app: "Vunemi", command: `PDF: ${String(a.out ?? a.path ?? "")}` }),
      async run(a, ctx) {
        const path = source(roots, a.path, [".docx"]);
        const out = pdfPath(roots, path, a.out);
        let html: string;
        try {
          const result = await exec("/usr/bin/textutil", ["-convert", "html", "-stdout", "-noload", path], {
            timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal: ctx.signal,
          });
          html = result.stdout;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          const reason = String((error as { stderr?: string }).stderr || (error as Error).message).trim().slice(0, 200);
          throw new Error(t("files.unreadable", { name: basename(path), reason }));
        }
        let pdf: Buffer;
        try {
          pdf = Buffer.from(await renderPdf(html, ctx.signal));
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          throw new Error(t("files.unreadable", { name: basename(path), reason: String((error as Error).message).slice(0, 200) }));
        }
        if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error(t("files.unreadable", { name: basename(path), reason: "Invalid PDF output" }));
        try {
          writeFileSync(out, pdf, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(t("files.exists", { path: out }));
          throw error;
        }
        ctx.produced?.({ kind: "file", path: out });
        return `Created PDF: ${out}`;
      },
    },
    {
      name: "excel_read_range",
      description: "Read an Excel workbook, up to 500 cells. For the workbook the user has open in Excel now, call it with no arguments: it finds that window itself and reads it, unsaved changes included, and says its path. For a saved .xlsx, give path. sheet and range are optional (active sheet, area in use).",
      parameters: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, range: { type: "string" } } },
      actionClass: "read", alwaysAsk: true, allowSessionApproval: true, approvalScope: () => "mac-app:microsoft-excel", untrustedOutput: true,
      preview: async (a) => t("connectors.apps.requestPreview", { app: `Excel: ${String(a.path ?? t("apps.excelOpenBook"))} ${String(a.range ?? "")}`.trim() }),
      async run(a, ctx) {
        const path = String(a.path ?? "").trim() ? source(roots, a.path, [".xlsx"]) : null;
        const sheet = String(a.sheet ?? "").trim() || null;
        const target = String(a.range ?? "").trim() ? range(a.range) : null;
        // Excel can't be asked (not allowed, or busy): the saved file still answers.
        const open = await live({ path, sheet, range: target?.text ?? null, maxCells: MAX_CELLS }, ctx.signal).catch((error: unknown) => {
          if (path) return null;
          throw error;
        });
        if (open?.noSheet) throw new Error(t("apps.error.noSheet", { sheet: sheet ?? "", sheets: (open.sheets ?? []).join(", ") }));
        if (open && !open.notOpen) {
          if (path === null && open.path) roots.resolve(open.path, "read");
          return bounded({ source: "open in Excel (unsaved changes included)", workbook: open.workbook, path: open.path, sheet: open.sheet, range: open.range, ...(open.truncated && { truncated: true }), values: open.values });
        }
        if (!path) throw new Error(t("apps.error.noWorkbook"));
        let area = target;
        let truncated = false;
        if (!area) {
          const used = xlsxUsedRange(path, sheet) ?? "A1";
          const whole = range(used, Infinity);
          const cols = Math.min(whole.cols, MAX_CELLS);
          const rows = Math.max(1, Math.min(whole.rows, Math.floor(MAX_CELLS / cols)));
          truncated = rows < whole.rows || cols < whole.cols;
          area = range(`${columnName(whole.start.col)}${whole.start.row}:${columnName(whole.start.col + cols - 1)}${whole.start.row + rows - 1}`);
        }
        const refs = refsOf(area);
        let read: ReturnType<typeof xlsxValues>;
        try {
          read = xlsxValues(path, sheet, refs);
        } catch (error) {
          const sheets = (() => { try { return xlsxSheets(path); } catch { return null; } })();
          if (sheet && sheets && !sheets.includes(sheet)) throw new Error(t("apps.error.noSheet", { sheet, sheets: sheets.join(", ") }));
          throw new Error(t("files.unreadable", { name: basename(path), reason: String((error as Error).message).slice(0, 200) }));
        }
        const values: SheetValue[][] = [];
        for (let i = 0; i < refs.length; i += area.cols) values.push(refs.slice(i, i + area.cols).map((ref) => read.values[ref] ?? ""));
        return bounded({ source: "saved file", path, sheet: read.sheet, range: area.text, ...(truncated && { truncated: true }), values });
      },
    },
    {
      name: "excel_write_range",
      description: "Write plain values into an Excel workbook's cells. For the workbook the user has open in Excel now, leave out path: the values appear in that window and the user saves. With path, a saved .xlsx; if it isn't open, the file is changed directly, no Excel needed. Every call needs approval; formulas are refused.",
      parameters: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, range: { type: "string" }, values: { type: "array", items: { type: "array" } }, replaceFormulas: { type: "boolean", description: "Only when the user asked to overwrite cells that hold formulas." } }, required: ["sheet", "range", "values"] },
      actionClass: "write-local", alwaysAsk: true,
      preview: async (a) => {
        const sheet = String(a.sheet ?? "").trim();
        return sheet
          ? t("connectors.apps.commandPreview", { app: "Excel", command: `${sheet}!${String(a.range ?? "")} (${String(a.path ?? "").trim() || t("apps.excelOpenBook")}) ${JSON.stringify(a.values ?? []).slice(0, 180)}` })
          : t("apps.error.sheetNeeded");
      },
      async run(a, ctx) {
        const sheet = String(a.sheet ?? "").trim();
        if (!sheet) throw new Error(t("apps.error.sheetNeeded"));
        const target = range(a.range);
        const cells = values(a.values, target.rows, target.cols);
        if (JSON.stringify(cells).length > 50_000) throw new Error("Too much cell data for one write.");
        const refs = refsOf(target);
        const replaceFormulas = a.replaceFormulas === true;
        if (!String(a.path ?? "").trim()) {
          // The workbook in front in Excel. Where it lives is checked before anything is written;
          // one never saved lives nowhere yet.
          const front = await live({ path: null, sheet, range: target.text }, ctx.signal);
          if (front.noSheet) throw new Error(t("apps.error.noSheet", { sheet, sheets: (front.sheets ?? []).join(", ") }));
          if (front.notOpen) throw new Error(t("apps.error.noWorkbook"));
          if (front.path) roots.resolve(front.path, "write");
          return writeOpen(front.path ?? null, front.workbook ?? "Excel", sheet, target, refs, cells, replaceFormulas, ctx);
        }
        const path = source(roots, a.path, [".xlsx"]);
        const label = t("apps.excel.undo", { range: `${sheet}!${target.text}`, name: basename(path) });

        // Open in Excel: the user's window is the workbook, so write there.
        let open: LiveResult | null;
        try {
          open = await live({ path, sheet, range: target.text, write: cells, replaceFormulas }, ctx.signal);
        } catch (error) {
          if (error instanceof AppScriptError && error.code === -1712) throw new AppScriptError(t("apps.error.writeUnknown", { app: EXCEL }), error.code);
          // Excel has it open but refused (no permission, or a step it can't do): its own words say why.
          // Writing the file under a workbook it has open would be lost when it saves.
          const holder = lockedBy(path);
          if (holder === EXCEL && error instanceof AppScriptError) throw error;
          if (holder) throw new Error(t("apps.error.alreadyOpen", { app: holder, name: basename(path) }));
          open = null;
        }
        if (open?.noSheet) throw new Error(t("apps.error.noSheet", { sheet, sheets: (open.sheets ?? []).join(", ") }));
        if (open?.formulas) throw new Error(formulaRefusal(refs.filter((_, i) => open!.formulas![Math.floor(i / target.cols)]?.[i % target.cols])));
        if (open && !open.notOpen) return reportOpen(open, path, sheet, target, refs, cells, label, ctx);

        // Not open anywhere Vunemi can reach: change the saved file itself.
        const holder = lockedBy(path);
        if (holder && holder !== EXCEL) throw new Error(t("apps.error.alreadyOpen", { app: holder, name: basename(path) }));
        const sheets = xlsxSheets(path);
        if (!sheets.includes(sheet)) throw new Error(t("apps.error.noSheet", { sheet, sheets: sheets.join(", ") }));
        const formulas = new Set<string>();
        const kinds = new Map<string, "n" | "s" | "b" | "e">();
        const before = xlsxCells(path, sheet, refs, formulas, kinds);
        if (formulas.size > 0 && !replaceFormulas) throw new Error(formulaRefusal([...formulas]));
        xlsxWrite(path, sheet, target.start, cells, { replaceFormulas });
        // Judge the write by the saved file.
        const disk = xlsxCells(path, sheet, refs);
        const wrong = refs.filter((ref, i) => !sameCell(disk[ref] ?? null, cells[Math.floor(i / target.cols)]![i % target.cols]!));
        if (wrong.length > 0) throw new Error(t("apps.error.notSaved", { app: "Vunemi", detail: wrong.slice(0, 5).join(", ") }));
        ctx.produced?.({ kind: "file", path });
        const replaced = refs.filter((ref) => before[ref] !== null && before[ref] !== undefined && before[ref] !== disk[ref]);
        // Values can be put back; a formula written over can't be, so no undo is offered then.
        // Neither can an error value, or text that would read back as a formula.
        const old = formulas.size === 0 ? restorable(before, kinds, refs, target.cols) : null;
        if (old) ctx.offerUndo(label, async () => undoInFile(path, sheet, target, refs, cells, old));
        const notes = [
          replaced.length > 0 ? `Replaced: ${replaced.slice(0, 10).map((ref) => `${ref} "${String(before[ref]).slice(0, 40)}"`).join(", ")}${replaced.length > 10 ? ` and ${replaced.length - 10} more` : ""}.` : "",
          formulas.size > 0 ? `As the user asked, these cells' formulas were replaced with plain values: ${[...formulas].slice(0, 10).join(", ")}. This can't be undone from here.` : "",
        ].filter(Boolean).join("\n");
        return `Written to the saved file, without Excel. Checked in the file: ${sheet}!${target.text} holds the new values. Formulas elsewhere are recalculated when the file is next opened.${notes ? `\n${notes}` : ""}`;
      },
    },
    {
      name: "powerpoint_outline", description: "Read text from up to 100 slides of an existing .pptx presentation.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      actionClass: "read", alwaysAsk: true, allowSessionApproval: true, approvalScope: () => "mac-app:microsoft-powerpoint", untrustedOutput: true,
      preview: async (a) => t("connectors.apps.requestPreview", { app: `PowerPoint: ${String(a.path ?? "")}` }),
      async run(a) {
        const path = source(roots, a.path, [".pptx"]);
        let outline: ReturnType<typeof pptxOutline>;
        try {
          outline = pptxOutline(path);
        } catch (error) {
          throw new Error(t("files.unreadable", { name: basename(path), reason: String((error as Error).message).slice(0, 200) }));
        }
        return bounded({ name: basename(path), ...outline });
      },
    },
  ];
  return tools.map((tool) => ({ ...tool, wantedFor: WANTED[tool.name.split("_")[0]!] }));
}
