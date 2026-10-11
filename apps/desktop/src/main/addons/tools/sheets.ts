/**
 * Spreadsheets, through GridCraft: a new workbook from a grid the model
 * writes. Formulas are the program's to calculate, so a total is never the
 * model's own arithmetic; what it calculated comes back in the result.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { deliver, expectFile, short, target, type AddonToolDeps } from "./common.js";

const MAX_ROWS = 2_000;
const MAX_COLS = 100;
const MAX_CELLS = 20_000;
const MAX_CELL_TEXT = 2_000;
/** What comes back for the model to report from. */
const MAX_PRINT = 4_000;
const CHARTS = ["column", "bar", "line", "pie"] as const;

export const SHEETS_GUIDE = `Making spreadsheets:
- sheet_make makes a new .xlsx file; it cannot change an existing one (excel_write_range does that, when the Mac apps connection is on).
- Write every total, average or percentage as a formula, in English function names with commas (=SUM(B2:B4)). Do not calculate it yourself.
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
  if (rows.length > 1) steps.push({ id: "home.bold", params: { range: `A1:${column(cols - 1)}1`, on: true } });
  steps.push({ id: "home.autofitColumnWidth", params: { cols: `A:${column(cols - 1)}` } });
  if (chart) steps.push({ id: "insert.chart", params: { range: chart.range, type: chart.type, ...(chart.title && { title: chart.title }), at: `${column(cols + 1)}2` } });
  return steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
}

export function sheetTools(deps: AddonToolDeps): ToolDef[] {
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
      async run(a, ctx) {
        const out = target(deps.roots, a.path, [".xlsx"]);
        const rows = grid(a.rows);
        const asked = a.chart as { range?: unknown; type?: unknown; title?: unknown } | undefined;
        let chart: { range: string; type: string; title?: string } | undefined;
        if (asked) {
          const range = String(asked.range ?? "").trim().toUpperCase();
          if (!/^[A-Z]{1,3}[0-9]{1,5}:[A-Z]{1,3}[0-9]{1,5}$/.test(range)) throw new Error("chart.range must be like A1:D4.");
          const type = CHARTS.find((kind) => kind === asked.type) ?? "column";
          const title = String(asked.title ?? "").trim().slice(0, 120);
          chart = { range, type, ...(title && { title }) };
        }
        const cols = Math.max(...rows.map((row) => row.length));
        const area = `A1:${column(cols - 1)}${rows.length}`;
        return deps.engines("sheets", ctx.signal, async (job) => {
          writeFileSync(join(job.dir, "steps.jsonl"), sheetScript(rows, chart));
          const made = join(job.dir, "out.xlsx");
          const result = await job.run(["run", "--script", "steps.jsonl", "--out", "out.xlsx", "--print", area, "--quiet"]);
          expectFile("GridCraft", result, made);
          deliver(made, out, ctx);
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
