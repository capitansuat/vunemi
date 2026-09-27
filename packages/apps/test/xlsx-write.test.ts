import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readZip, xlsxCells } from "../src/ooxml.js";
import { recalcOnOpen, setCells, xlsxWrite } from "../src/xlsx-write.js";
import { writeZip } from "./zip.js";

const dir = mkdtempSync(join(tmpdir(), "vunemi-xlsx-write-"));
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function book(name: string, sheet: string, extra: Record<string, string> = {}): string {
  const path = join(dir, name);
  writeZip(path, {
    "[Content_Types].xml": `<Types><Override PartName="/xl/calcChain.xml" ContentType="x"/></Types>`,
    "xl/workbook.xml": `<workbook xmlns:r="${REL}"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="${REL}/calcChain" Target="calcChain.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
    "xl/styles.xml": "<styleSheet/>",
    ...extra,
  });
  return path;
}

const part = (path: string, name: string) => readZip(path, (text) => text(name));

describe("writing a workbook without Excel", () => {
  it("writes into place, keeping styles, row order and every other part", () => {
    const path = book("keep.xlsx", `<worksheet><dimension ref="A1:B3"/><sheetData><row r="1" spans="1:2"><c r="A1" s="4" t="s"><v>0</v></c><c r="B1"><v>1</v></c></row><row r="3"><c r="B3"><v>3</v></c></row></sheetData></worksheet>`, { "xl/sharedStrings.xml": "<sst><si><t>keep</t></si></sst>" });
    xlsxWrite(path, "Sheet", { row: 1, col: 1 }, [["new & <ok>", 2], [true, null]]);
    expect(xlsxCells(path, "Sheet", ["A1", "B1", "A2", "B2", "B3"])).toEqual({ A1: "new & <ok>", B1: "2", A2: "TRUE", B2: null, B3: "3" });
    const sheet = part(path, "xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="A1" s="4" t="inlineStr">');
    expect(sheet.indexOf('<row r="2"')).toBeGreaterThan(sheet.indexOf('<row r="1"'));
    expect(sheet.indexOf('<row r="2"')).toBeLessThan(sheet.indexOf('<row r="3"'));
    expect(sheet).not.toContain("spans=");
    expect(sheet).toContain('<dimension ref="A1:B3"/>');
    expect(part(path, "xl/sharedStrings.xml")).toBe("<sst><si><t>keep</t></si></sst>");
    expect(part(path, "xl/workbook.xml")).toContain('<calcPr fullCalcOnLoad="1" calcId="191029"/>');
    expect(part(path, "xl/calcChain.xml")).toBeNull();
    // Nothing left beside it.
    expect(readdirSync(dir).filter((name) => name.includes("vunemi-tmp"))).toEqual([]);
  });

  it("writes into an empty sheet and says so in its dimension", () => {
    const path = book("empty.xlsx", `<worksheet><dimension ref="A1"/><sheetData/></worksheet>`);
    xlsxWrite(path, "Sheet", { row: 2, col: 3 }, [["x"]]);
    expect(xlsxCells(path, "Sheet", ["C2"])).toEqual({ C2: "x" });
    expect(part(path, "xl/worksheets/sheet1.xml")).toContain('<dimension ref="C2"/>');
  });

  it("refuses a formula unless asked, and one other cells share always", () => {
    const shared = book("shared.xlsx", `<worksheet><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f><v>2</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`);
    const before = readFileSync(shared);
    expect(() => xlsxWrite(shared, "Sheet", { row: 1, col: 2 }, [["x"]])).toThrow(/B1 holds a formula/);
    expect(() => xlsxWrite(shared, "Sheet", { row: 1, col: 1 }, [["x"]], { replaceFormulas: true })).toThrow(/other cells share/);
    expect(readFileSync(shared).equals(before)).toBe(true);
    // Asked for, the formula goes, and so does the calculation chain that pointed at it.
    const chained = book("chained.xlsx", `<worksheet><sheetData><row r="1"><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`, { "xl/calcChain.xml": `<calcChain><c r="B1" i="1"/></calcChain>` });
    expect(xlsxWrite(chained, "Sheet", { row: 1, col: 2 }, [[5]], { replaceFormulas: true })).toEqual({ formulas: ["B1"] });
    expect(part(chained, "xl/calcChain.xml")).toBeNull();
    expect(part(chained, "[Content_Types].xml")).not.toContain("calcChain");
    expect(part(chained, "xl/_rels/workbook.xml.rels")).not.toContain("calcChain");
  });

  it("keeps the calculation chain when no formula was touched", () => {
    const path = book("chainkept.xlsx", `<worksheet><sheetData><row r="1"><c r="B1"><f>A1*2</f><v>2</v></c></row></sheetData></worksheet>`, { "xl/calcChain.xml": `<calcChain><c r="B1" i="1"/></calcChain>` });
    xlsxWrite(path, "Sheet", { row: 1, col: 1 }, [[4]]);
    expect(part(path, "xl/calcChain.xml")).toContain("B1");
  });

  it("refuses text a workbook can't hold, and a sheet it can't find", () => {
    const path = book("bad.xlsx", `<worksheet><sheetData/></worksheet>`);
    expect(() => xlsxWrite(path, "Sheet", { row: 1, col: 1 }, [["a\u0001b"]])).toThrow(/characters/);
    expect(() => xlsxWrite(path, "Other", { row: 1, col: 1 }, [["x"]])).toThrow(/Other/);
  });

  it("puts calcPr where the schema expects it when there is none", () => {
    expect(recalcOnOpen("<workbook><sheets/></workbook>")).toBe("<workbook><sheets/></workbook>");
    expect(recalcOnOpen("<workbook><sheets></sheets><definedNames><definedName/></definedNames></workbook>")).toBe(
      '<workbook><sheets></sheets><definedNames><definedName/></definedNames><calcPr fullCalcOnLoad="1"/></workbook>',
    );
  });

  it("leaves rows it doesn't write to exactly as they were", () => {
    const row = `<row r="5" ht="30" customHeight="1"><c r="A5" s="2"><v>1</v></c></row>`;
    const { xml } = setCells(`<worksheet><sheetData>${row}</sheetData></worksheet>`, { row: 1, col: 1 }, [["x"]]);
    expect(xml).toContain(row);
  });
});
