import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pptxOutline, xlsxCells } from "../src/ooxml.js";
import { writePptx, writeXlsx } from "./zip.js";

const dir = mkdtempSync(join(tmpdir(), "vunemi-ooxml-"));

describe("reading Office files from disk", () => {
  it("lists slide text in presentation order, not file order, with entities decoded", () => {
    const path = join(dir, "order.pptx");
    writePptx(path, [["First &amp; best", "second line"], ["Last"]]);
    expect(pptxOutline(path)).toEqual({
      slides: [
        { number: 1, text: "First & best\nsecond line" },
        { number: 2, text: "Last" },
      ],
      total: 2,
      truncated: false,
    });
  });

  it("reads shared, inline, numeric and boolean cells and reports missing ones as empty", () => {
    const path = join(dir, "cells.xlsx");
    writeXlsx(
      path,
      "Vunemi &amp; Test",
      `<c r="A1" t="s"><v>1</v></c><c r="B1"><v>7429</v></c><c r="C1" t="inlineStr"><is><t>verified</t></is></c><c r="D1" t="b"><v>1</v></c><c r="E1" s="2"/>`,
      ["unused", "blue lantern"],
    );
    expect(xlsxCells(path, "Vunemi & Test", ["A1", "B1", "C1", "D1", "E1", "F1"])).toEqual({
      A1: "blue lantern", B1: "7429", C1: "verified", D1: "TRUE", E1: null, F1: null,
    });
    expect(() => xlsxCells(path, "Other", ["A1"])).toThrow(/Other/);
  });

  it("refuses a file that is not a zip archive", () => {
    const path = join(dir, "fake.pptx");
    writeFileSync(path, "not an office file");
    expect(() => pptxOutline(path)).toThrow(/protected|readable/);
  });
});
