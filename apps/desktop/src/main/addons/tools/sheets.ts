/**
 * Spreadsheets, through GridCraft: a new workbook from a grid the model
 * writes. Formulas are the program's to calculate, so a total is never the
 * model's own arithmetic; what it calculated comes back in the result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { EngineJob } from "../jobs.js";
import { deliver, expectFile, short, show, target, tried, type AddonToolDeps } from "./common.js";

const MAX_ROWS = 2_000;
const MAX_COLS = 100;
const MAX_CELLS = 20_000;
const MAX_CELL_TEXT = 2_000;
/** What comes back for the model to report from. */
const MAX_PRINT = 4_000;
const CHARTS = ["column", "bar", "line", "pie"] as const;
/** Past this the table is not drawn: the picture shows only its top anyway. */
const MAX_HTML = 2_000_000;

export const SHEETS_GUIDE = `Making spreadsheets:
- sheet_make makes a new .xlsx file. For existing workbooks, multiple sheets, pivot tables and all other GridCraft features use sheets_engine_run.
- Write every total, average or percentage as a formula, in English function names with commas (=SUM(B2:B4)). Do not calculate it yourself.
- Use distinct descriptive headers (for example Item and Value), not repeated generic headings. New tables receive readable row spacing and aligned numeric columns; fractional numeric columns keep consistent precision without adding currency.
- Its result shows the grid as calculated. Report numbers from that result, never from your own sums.`;

/** A1-style column letters: 0 is A, 26 is AA. */
export function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

type Cell = string | number;

function grid(input: unknown): Cell[][] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("rows must be a list of rows, each a list of cells.");
  if (input.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} rows.`);
  const rows = input.map((row) => {
    if (!Array.isArray(row)) throw new Error("Each row must be a list of cells.");
    if (row.length > MAX_COLS) throw new Error(`At most ${MAX_COLS} columns.`);
    return row.map((cell): Cell => (typeof cell === "number" && Number.isFinite(cell) ? cell : cell === null || cell === undefined ? "" : String(cell).slice(0, MAX_CELL_TEXT)));
  });
  if (rows.reduce((n, row) => n + row.length, 0) > MAX_CELLS) throw new Error(`At most ${MAX_CELLS} cells.`);
  return rows;
}

/** The program's commands for a grid, one JSON object a line. */
export function sheetScript(rows: Cell[][], chart?: { range: string; type: string; title?: string }): string {
  const cols = Math.max(...rows.map((row) => row.length));
  const steps: { id: string; params: Record<string, unknown> }[] = [];
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell !== "") steps.push({ id: "cell.set", params: { cell: `${column(c)}${r + 1}`, input: String(cell) } });
    }),
  );
  const header = `A1:${column(cols - 1)}1`;
  steps.push({ id: "home.rowHeight", params: { rows: `1:${rows.length}`, height: 32 } });
  steps.push({ id: "home.alignMiddle", params: { range: `A1:${column(cols - 1)}${rows.length}` } });
  if (rows.length > 1) {
    steps.push({ id: "home.bold", params: { range: header, on: true } });
    steps.push({ id: "home.fillColor", params: { range: header, color: "#EDF2F6" } });
    for (let c = 0; c < cols; c++) {
      const values = rows.slice(1).map(row => row[c]).filter(value => value !== undefined && value !== "");
      const literals = values.filter(value => !String(value).startsWith("="));
      const numeric = literals.length > 0 && literals.every(value => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value)));
      if (!numeric) continue;
      const range = `${column(c)}2:${column(c)}${rows.length}`;
      steps.push({ id: "home.alignRight", params: { range } });
      const precision = Math.max(...literals.map(value => String(value).split(".")[1]?.length ?? 0));
      // Keep supplied precision, including totals; formatting never rewrites stored values.
      if (precision > 0 && precision <= 12) steps.push({ id: "home.numberFormat", params: { range, code: `0.${"0".repeat(Math.max(2, precision))}` } });
    }
    rows.slice(1).forEach((row, index) => {
      if (typeof row[0] === "string" && /^(?:total|toplam|genel toplam)$/i.test(row[0].trim())) steps.push({ id: "home.bold", params: { range: `A${index + 2}:${column(cols - 1)}${index + 2}`, on: true } });
    });
  }
  steps.push({ id: "home.autofitColumnWidth", params: { cols: `A:${column(cols - 1)}` } });
  if (chart) steps.push({ id: "insert.chart", params: { range: chart.range, type: chart.type, ...(chart.title && { title: chart.title }), at: `${column(cols + 1)}2` } });
  return steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
}

export function sheetTools(deps: AddonToolDeps): ToolDef[] {
  const asked = (a: Record<string, unknown>) => {
    const out = target(deps.roots, a.path, [".xlsx"]);
    const rows = grid(a.rows);
    const wanted = a.chart as { range?: unknown; type?: unknown; title?: unknown } | undefined;
    if (!wanted) return { out, rows };
    const range = String(wanted.range ?? "").trim().toUpperCase();
    if (!/^[A-Z]{1,3}[0-9]{1,5}:[A-Z]{1,3}[0-9]{1,5}$/.test(range)) throw new Error("chart.range must be like A1:D4.");
    // A chart over empty cells is a chart of nothing: one model sent only the header with a chart of A1:B32.
    const cols = Math.max(...rows.map((row) => row.length));
    const [lastCol, lastRow] = range.split(":").reduce(([c, r], corner) => {
      const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(corner)!;
      const index = [...letters!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      return [Math.max(c, index), Math.max(r, Number(digits))];
    }, [0, 0]);
    if (rows.length < 2 || lastRow > rows.length || lastCol > cols) {
      throw new Error(`chart.range ${range} covers cells with no data: the table fills A1:${column(cols - 1)}${rows.length}${rows.length < 2 ? ", the header only" : ""}. Chart only cells that hold the rows given. Nothing was made.`);
    }
    const type = CHARTS.find((kind) => kind === wanted.type) ?? "column";
    const title = String(wanted.title ?? "").trim().slice(0, 120);
    return { out, rows, chart: { range, type, ...(title && { title }) } };
  };
  return [
    {
      name: "sheet_make",
      description: "Make a new Excel workbook (.xlsx). rows is the grid from A1: a cell is text, a number, or a formula starting with '='. The first row is the header. Returns the grid as calculated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to save it, ending in .xlsx" },
          rows: { type: "array", items: { type: "array", items: { type: ["string", "number"] } } },
          chart: {
            type: "object",
            properties: { range: { type: "string", description: "Cells to chart, e.g. A1:D4" }, type: { type: "string", enum: [...CHARTS] }, title: { type: "string" } },
            required: ["range"],
          },
        },
        required: ["path", "rows"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.path ?? "")) }),
      check: (a) => tried(() => asked(a)),
      async run(a, ctx) {
        const { out, rows, chart } = asked(a);
        const cols = Math.max(...rows.map((row) => row.length));
        const area = `A1:${column(cols - 1)}${rows.length}`;
        /** The table as the program lays it out, for the user to see. A file without a picture is still a file. */
        const picture = async (job: EngineJob): Promise<void> => {
          if (!deps.picture) return;
          await job.run(["convert", "out.xlsx", "shown.html"]);
          const html = readFileSync(join(job.dir, "shown.html"), "utf8");
          if (html.length > MAX_HTML) return;
          writeFileSync(join(job.dir, "shown.png"), await deps.picture(html, ctx.signal));
          show(deps, join(job.dir, "shown.png"), short(out), ctx);
        };
        return deps.engines("sheets", ctx.signal, async (job) => {
          writeFileSync(join(job.dir, "steps.jsonl"), sheetScript(rows, chart));
          const made = join(job.dir, "out.xlsx");
          const result = await job.run(["run", "--script", "steps.jsonl", "--out", "out.xlsx", "--print", area, "--quiet"]);
          expectFile("GridCraft", result, made);
          deliver(made, out, ctx);
          await picture(job).catch(() => {});
          const shown = result.stdout.trim();
          return [
            `Created ${short(out)}: ${rows.length} rows, ${cols} columns${chart ? `, one ${chart.type} chart of ${chart.range}` : ""}.`,
            shown ? `As calculated (${area}):\n${shown.length > MAX_PRINT ? `${shown.slice(0, MAX_PRINT)}\n[more rows not shown]` : shown}` : "",
            /#(?:NAME|REF|VALUE|DIV\/0|N\/A)[!?]?/.test(shown) ? "Some cells show an error (#NAME?, #REF! …): a formula is wrong. Say so; the file is there, and a corrected one needs a new name." : "",
          ].filter(Boolean).join("\n");
        });
      },
    },
  ];
}
