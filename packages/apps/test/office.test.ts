import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { Roots } from "@ocak/files";
import { createOfficeTools, FIND_WORKBOOK, EXCEL_LIVE as EXCEL_LIVE_FOR_TEST } from "../src/office.js";
import { AppScriptError } from "../src/runner.js";
import { writePptx, writeXlsx, writeZip } from "./zip.js";
import { xlsxCells } from "../src/ooxml.js";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const base = mkdtempSync(join(tmpdir(), "tenami-office-test-"));
const allowed = join(base, "allowed");
const outside = join(base, "outside");
mkdirSync(allowed); mkdirSync(outside);
const docx = join(allowed, "sample.docx");
const xlsx = join(allowed, "sample.xlsx");
const pptx = join(allowed, "sample.pptx");
writeFileSync(docx, "fixture"); writeFileSync(xlsx, "fixture"); writeFileSync(pptx, "fixture");
const undos: { label: string; undo: () => Promise<void> }[] = [];
const ctx = { signal: new AbortController().signal, offerUndo: (label: string, undo: () => Promise<void>) => undos.push({ label, undo }) } as never;
const catalog = { find: async (id: string) => ({ path: `/Applications/${id}.app` }) };
const tool = (
  name: string,
  run = vi.fn(async (_template: string, _args: unknown, _opts?: unknown): Promise<unknown> => ({ name: "Sample", text: "Hello", values: [[1]], slides: [] })),
  renderPdf = vi.fn(async (_html: string, _signal: AbortSignal) => Buffer.from("%PDF-test")),
) => {
  const found = createOfficeTools(run, new Roots([allowed]), catalog, renderPdf).find((entry) => entry.name === name)!;
  return { found, run, renderPdf };
};

function actualDocx(name: string): string {
  const plain = join(allowed, `${name}.txt`);
  const documentPath = join(allowed, `${name}.docx`);
  writeFileSync(plain, "blue lantern 7429\n");
  execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", documentPath, plain]);
  return documentPath;
}

describe("Office presets", () => {
  it("keeps read and write approval modes separate", () => {
    const list = createOfficeTools(async () => null, new Roots([allowed]), catalog, async () => Buffer.from("%PDF-test"));
    expect(list.map((t) => t.name)).toEqual(["word_read", "word_export_pdf", "excel_read_range", "excel_write_range", "powerpoint_outline"]);
    for (const item of list) {
      expect(item.alwaysAsk).toBe(true);
      if (item.actionClass === "read") expect(item).toMatchObject({ allowSessionApproval: true, untrustedOutput: true });
      else expect(item.allowSessionApproval).toBeUndefined();
    }
  });

  it.skipIf(process.platform !== "darwin")("reads actual .docx text without opening Word", async () => {
    const documentPath = actualDocx("word-read");
    const { found, run } = tool("word_read");
    await expect(found.run({ path: documentPath }, ctx)).resolves.toContain("blue lantern 7429");
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")("renders actual .docx HTML and writes only a verified new PDF", async () => {
    const documentPath = actualDocx("word-export");
    const out = join(allowed, "word-export.pdf");
    const { found, run, renderPdf } = tool("word_export_pdf");
    await expect(found.run({ path: documentPath, out }, ctx)).resolves.toContain("Created PDF");
    expect(run).not.toHaveBeenCalled();
    expect(renderPdf).toHaveBeenCalledOnce();
    expect(renderPdf.mock.calls[0]![0]).toContain("blue lantern 7429");
    expect(readFileSync(out).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it.skipIf(process.platform !== "darwin")("refuses invalid renderer output before creating a file", async () => {
    const documentPath = actualDocx("bad-render");
    const out = join(allowed, "bad-render.pdf");
    const { found } = tool("word_export_pdf", undefined, vi.fn(async () => Buffer.from("not PDF")));
    await expect(found.run({ path: documentPath, out }, ctx)).rejects.toThrow();
    expect(() => readFileSync(out)).toThrow();
  });

  it("refuses files outside the allowed roots", async () => {
    const wrong = join(outside, "secret.xlsx");
    writeFileSync(wrong, "fixture");
    const { found, run } = tool("excel_read_range");
    await expect(found.run({ path: wrong, range: "A1" }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid or oversized Excel ranges before calling Office", async () => {
    const { found, run } = tool("excel_read_range");
    await expect(found.run({ path: xlsx, range: "A1:Z100" }, ctx)).rejects.toThrow(/500/);
    await expect(found.run({ path: xlsx, range: "A0" }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("requires an explicit worksheet for every Excel write", async () => {
    const { found, run } = tool("excel_write_range");
    expect(found.parameters.required).toContain("sheet");
    const args = { path: xlsx, range: "C1", values: [["verified"]] };
    const preview = await found.preview!(args);
    expect(preview).toBeTruthy();
    expect(preview).not.toContain("!C1");
    await expect(found.run(args, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects mismatched data and formulas before a write", async () => {
    const { found, run } = tool("excel_write_range");
    await expect(found.run({ path: xlsx, sheet: "Test", range: "A1:B2", values: [[1, 2]] }, ctx)).rejects.toThrow();
    await expect(found.run({ path: xlsx, sheet: "Test", range: "A1", values: [["=HYPERLINK(\"https://x\")"]] }, ctx)).rejects.toThrow(/formulas/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses PDF overwrite and output paths outside allowed roots", async () => {
    const { found, run } = tool("word_export_pdf");
    const pdf = join(allowed, "already.pdf");
    writeFileSync(pdf, "%PDF-test");
    await expect(found.run({ path: docx, out: pdf }, ctx)).rejects.toThrow();
    expect(readFileSync(pdf, "utf8")).toBe("%PDF-test");
    await expect(found.run({ path: docx, out: join(outside, "new.pdf") }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("reads PowerPoint slides from the file without opening PowerPoint", async () => {
    const path = join(allowed, "deck.pptx");
    writePptx(path, [["Vunemi Office test", "blue lantern 7429"]]);
    const { found, run } = tool("powerpoint_outline");
    const out = JSON.parse(await found.run({ path }, ctx));
    expect(out).toMatchObject({ name: "deck.pptx", total: 1, slides: [{ number: 1, text: "Vunemi Office test\nblue lantern 7429" }] });
    expect(run).not.toHaveBeenCalled();
  });

});

/** An Excel that has no workbook open: every Excel tool works on the saved file. */
const closed = () => vi.fn(async (_t: unknown, _args: unknown, _opts?: unknown): Promise<unknown> => ({ notOpen: true }));
const cellsOf = (book: string, refs: string[], sheet = "Sheet") => xlsxCells(book, sheet, refs);

describe("Excel without Excel", () => {
  it("writes the saved file itself, keeping the rest of the workbook", async () => {
    const book = join(allowed, "written.xlsx");
    writeXlsx(book, "Sheet", `<c r="A1" t="s"><v>0</v></c><c r="B1"><v>7429</v></c>`, ["blue lantern"]);
    const out = await tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet", range: "c1:f1", values: [["verified", 5, false, null]] }, ctx);
    expect(out).toContain("without Excel");
    expect(out).toContain("Checked in the file: Sheet!C1:F1");
    expect(cellsOf(book, ["A1", "B1", "C1", "D1", "E1", "F1"])).toEqual({ A1: "blue lantern", B1: "7429", C1: "verified", D1: "5", E1: "FALSE", F1: null });
  });

  it("says which sheets there are when the one asked for isn't", async () => {
    const book = join(allowed, "sheets.xlsx");
    writeXlsx(book, "Budget", "");
    await expect(tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet1", range: "A1", values: [["x"]] }, ctx)).rejects.toThrow(/Budget/);
  });

  it("won't write over a formula unless asked, and puts replaced values back on undo", async () => {
    const book = join(allowed, "formula.xlsx");
    writeXlsx(book, "Sheet", `<c r="A1"><f>1+1</f><v>2</v></c>`);
    await expect(tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["x"]] }, ctx)).rejects.toThrow(/formula/);
    expect(cellsOf(book, ["A1"])).toEqual({ A1: "2" });

    const plain = join(allowed, "plain.xlsx");
    writeXlsx(plain, "Sheet", `<c r="A1" t="s"><v>0</v></c>`, ["blue lantern"]);
    undos.length = 0;
    const out = await tool("excel_write_range", closed()).found.run({ path: plain, sheet: "Sheet", range: "A1", values: [["verified"]] }, ctx);
    expect(out).toContain('Replaced: A1 "blue lantern"');
    expect(undos).toHaveLength(1);
    await undos[0]!.undo();
    expect(cellsOf(plain, ["A1"])).toEqual({ A1: "blue lantern" });
  });

  it("puts a number back as a number, and won't undo over the user's later edit", async () => {
    const book = join(allowed, "number.xlsx");
    writeXlsx(book, "Sheet", `<c r="A1"><v>7429</v></c>`);
    undos.length = 0;
    await tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["new"]] }, ctx);
    await undos[0]!.undo();
    const kinds = new Map<string, string>();
    expect(xlsxCells(book, "Sheet", ["A1"], undefined, kinds as never)).toEqual({ A1: "7429" });
    expect(kinds.get("A1")).toBe("n");

    const edited = join(allowed, "edited.xlsx");
    writeXlsx(edited, "Sheet", `<c r="A1" t="s"><v>0</v></c>`, ["old"]);
    undos.length = 0;
    await tool("excel_write_range", closed()).found.run({ path: edited, sheet: "Sheet", range: "A1", values: [["vunemi"]] }, ctx);
    writeXlsx(edited, "Sheet", `<c r="A1" t="s"><v>0</v></c>`, ["user edit"]);
    await expect(undos[0]!.undo()).rejects.toThrow(/A1/);
    expect(cellsOf(edited, ["A1"])).toEqual({ A1: "user edit" });
  });

  it("offers no undo when the old text would come back as a formula", async () => {
    const book = join(allowed, "textformula.xlsx");
    writeXlsx(book, "Sheet", `<c r="A1" t="s"><v>0</v></c>`, ["=not a formula"]);
    undos.length = 0;
    await tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["x"]] }, ctx);
    expect(undos).toHaveLength(0);
  });

  it("refuses a workbook another app holds open, and writes nothing", async () => {
    const book = join(allowed, "libre.xlsx");
    writeXlsx(book, "Sheet", "");
    writeFileSync(join(allowed, ".~lock.libre.xlsx#"), "");
    await expect(tool("excel_write_range", closed()).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["x"]] }, ctx)).rejects.toThrow(/libre\.xlsx.*LibreOffice/);
    expect(cellsOf(book, ["A1"])).toEqual({ A1: null });
  });

  it("reads the area in use from the file, with numbers, booleans and dates as such", async () => {
    const book = join(allowed, "read.xlsx");
    writeZip(book, {
      "xl/workbook.xml": `<workbook xmlns:r="${REL}"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/styles.xml": `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><dimension ref="A1:C2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Tarih</t></is></c><c r="B1" s="1"><v>46291</v></c><c r="C1" s="2"><v>46291.5</v></c></row><row r="2"><c r="A2"><v>12.5</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>`,
    });
    const out = JSON.parse(await tool("excel_read_range", closed()).found.run({ path: book }, ctx));
    expect(out).toMatchObject({ source: "saved file", sheet: "Sheet", range: "A1:C2", values: [["Tarih", "2026-09-26", "2026-09-26 12:00"], [12.5, true, ""]] });
  });

  it("asks which file when nothing is open in Excel and no path was given", async () => {
    await expect(tool("excel_read_range", closed()).found.run({}, ctx)).rejects.toThrow(/Excel/);
  });
});

describe("a workbook open in Excel", () => {
  it("reads the open window, unsaved changes included, and only asks Excel briefly", async () => {
    const excel = vi.fn(async (_t: unknown, _args: unknown, _opts?: unknown): Promise<unknown> => ({ workbook: "Budget.xlsx", path: join(allowed, "Budget.xlsx"), sheet: "Sheet", range: "A1:B1", values: [["unsaved", 3]] }));
    const out = JSON.parse(await tool("excel_read_range", excel).found.run({}, ctx));
    expect(out).toMatchObject({ source: "open in Excel (unsaved changes included)", workbook: "Budget.xlsx", values: [["unsaved", 3]] });
    expect(excel.mock.calls[0]![1]).toMatchObject({ path: null, sheet: null, range: null, app: "Microsoft Excel" });
    expect(excel.mock.calls[0]![2]).toMatchObject({ timeoutMs: 30_000 });
  });

  it("says Excel refused, rather than that nothing is open", async () => {
    const excel = vi.fn(async (): Promise<unknown> => { throw new AppScriptError("Vunemi isn't allowed to control Microsoft Excel.", -1743); });
    await expect(tool("excel_read_range", excel).found.run({}, ctx)).rejects.toThrow(/allowed/);
  });

  it("finds nothing open when Excel has no workbooks", () => {
    const script = new Function("Application", `${EXCEL_LIVE_FOR_TEST}; return run;`);
    const app = { running: () => true, workbooks: () => [] };
    expect(JSON.parse((script(() => app) as (argv: string[]) => string)([JSON.stringify({ path: null })]))).toEqual({ notOpen: true });
    const denied = { running: () => true, workbooks: () => { throw Object.assign(new Error("not allowed"), { errorNumber: -1743 }); } };
    expect(() => (script(() => denied) as (argv: string[]) => string)([JSON.stringify({ path: null })])).toThrow(/not allowed/);
    // Anything else Excel refuses is named by its step.
    const odd = { running: () => true, workbooks: () => [{}], activeWorkbook: () => { throw Object.assign(new Error("Can't get object."), { errorNumber: -1728 }); } };
    expect(JSON.parse((script(() => odd) as (argv: string[]) => string)([JSON.stringify({ path: null })]))).toEqual({ failed: "workbook", reason: "Can't get object." });
  });

  it("won't show a workbook open from outside the allowed folders", async () => {
    const excel = vi.fn(async (): Promise<unknown> => ({ workbook: "Secret.xlsx", path: join(outside, "Secret.xlsx"), sheet: "Sheet", range: "A1", values: [["x"]] }));
    await expect(tool("excel_read_range", excel).found.run({}, ctx)).rejects.toThrow();
  });

  it("writes into the open window, leaves saving to the user, and undoes there", async () => {
    const book = join(allowed, "live.xlsx");
    writeXlsx(book, "Sheet", "");
    const excel = vi.fn(async (_t: unknown, args: unknown): Promise<unknown> => {
      const write = (args as { write?: unknown[][] }).write;
      if (write && excel.mock.calls.length === 1) return { workbook: "live.xlsx", sheet: "Sheet", range: "A1", before: [[7]], values: [["new"]] };
      if (write) return { workbook: "live.xlsx", sheet: "Sheet", range: "A1", values: write };
      return { workbook: "live.xlsx", sheet: "Sheet", range: "A1", values: [["new"]] };
    });
    undos.length = 0;
    const out = await tool("excel_write_range", excel).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["new"]] }, ctx);
    expect(out).toMatch(/open in Excel.*not saved yet/is);
    expect(out).toContain('Replaced: A1 "7"');
    expect(cellsOf(book, ["A1"])).toEqual({ A1: null });
    await undos[0]!.undo();
    expect((excel.mock.calls[2]![1] as { write: unknown }).write).toEqual([[7]]);
  });

  it("writes into the workbook in front when no path is given, once its folder is allowed", async () => {
    const calls: unknown[] = [];
    const front = (where: string) => vi.fn(async (_t: unknown, args: unknown): Promise<unknown> => {
      calls.push(args);
      const write = (args as { write?: unknown[][] }).write;
      return { workbook: "Front.xlsx", path: where, sheet: "Sheet", range: "D1", ...(write && { before: [[""]] }), values: write ?? [[""]] };
    });
    // Gemma 4 E2B, live: no path, and one cell as a flat list.
    const out = await tool("excel_write_range", front(join(allowed, "Front.xlsx"))).found.run({ sheet: "Sheet", range: "D1", values: ["canlı"] }, ctx);
    expect(out).toMatch(/Front\.xlsx, which is open in Excel/);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { write: unknown }).write).toEqual([["canlı"]]);

    calls.length = 0;
    await expect(tool("excel_write_range", front(join(outside, "Secret.xlsx"))).found.run({ sheet: "Sheet", range: "D1", values: [["x"]] }, ctx)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    await expect(tool("excel_write_range", closed()).found.run({ sheet: "Sheet", range: "D1", values: [["x"]] }, ctx)).rejects.toThrow(/Excel/);
  });

  it("refuses formulas it finds in the open window", async () => {
    const book = join(allowed, "liveformula.xlsx");
    writeXlsx(book, "Sheet", "");
    const excel = vi.fn(async (): Promise<unknown> => ({ workbook: "x", sheet: "Sheet", range: "A1:B1", formulas: [[false, true]] }));
    await expect(tool("excel_write_range", excel).found.run({ path: book, sheet: "Sheet", range: "A1:B1", values: [["a", "b"]] }, ctx)).rejects.toThrow(/B1 holds a formula/);
  });

  it("fails when Excel doesn't show what was written", async () => {
    const book = join(allowed, "notshown.xlsx");
    writeXlsx(book, "Sheet", "");
    const excel = vi.fn(async (): Promise<unknown> => ({ workbook: "x", sheet: "Sheet", range: "B1:C1", before: [["", ""]], values: [["verified", ""]] }));
    await expect(tool("excel_write_range", excel).found.run({ path: book, sheet: "Sheet", range: "B1:C1", values: [["verified", 5]] }, ctx)).rejects.toThrow(/C1/);
  });

  it("won't write the file under an Excel it can't ask", async () => {
    const book = join(allowed, "locked.xlsx");
    writeXlsx(book, "Sheet", "");
    writeFileSync(join(allowed, "~$locked.xlsx"), "");
    const excel = vi.fn(async (): Promise<unknown> => { throw new AppScriptError("not allowed", -1743); });
    await expect(tool("excel_write_range", excel).found.run({ path: book, sheet: "Sheet", range: "A1", values: [["x"]] }, ctx)).rejects.toThrow(/not allowed/);
    expect(cellsOf(book, ["A1"])).toEqual({ A1: null });
  });

  it("says a timed-out write has an unknown outcome", async () => {
    const book = join(allowed, "slow.xlsx");
    writeXlsx(book, "Sheet", "");
    const excel = vi.fn(async (): Promise<unknown> => { throw new AppScriptError("late", -1712); });
    const error = await tool("excel_write_range", excel).found.run({ path: book, sheet: "Sheet", range: "C1", values: [["x"]] }, ctx).catch((e: Error) => e);
    expect(error).toBeInstanceOf(AppScriptError);
    expect((error as Error).message).not.toBe("late");
  });
});

describe("Excel limits", () => {
  it("writes up to 500 cells and refuses 501 before asking Excel", async () => {
    const { found, run } = tool("excel_write_range");
    const row = (n: number) => Array.from({ length: n }, () => "x");
    await expect(found.run({ path: xlsx, sheet: "Sheet", range: "A1:A501", values: row(501).map((v) => [v]) }, ctx)).rejects.toThrow(/500/);
    expect(run).not.toHaveBeenCalled();
    await expect(found.run({ path: xlsx, sheet: "Nope", range: "A1:T25", values: Array.from({ length: 25 }, () => row(20)) }, ctx)).rejects.not.toThrow(/500/);
  });
});

describe("Office script templates", () => {
  it("treats Excel's missing workbook list as no open workbooks", () => {
    const find = new Function(`${FIND_WORKBOOK}; return openWorkbookAt;`)() as (app: unknown, path: string) => unknown;
    expect(find({ workbooks: () => null }, "/x/a.xlsx")).toBeNull();
    const open = { fullName: () => "Macintosh HD:x:a.xlsx" };
    expect(find({ workbooks: () => [open] }, "/x/a.xlsx")).toBe(open);
  });
});
