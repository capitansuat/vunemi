/**
 * The tools add-ons give the model. The programs themselves are not run
 * here: a stand-in records what it was asked and leaves the file a real one
 * would. What is tested is this side: what the program is asked to do, that
 * its work lands only where the user's folders allow, that nothing is ever
 * replaced, and that a failure is reported as one.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry, type Artifact, type Produced, type ToolContext, type ToolDef } from "@vunemi/agent-core";
import { Roots } from "@vunemi/files";
import { createEngines, type Engines } from "../../src/main/addons/jobs.js";
import { PACKS, addonAreas, addonInstructions, pathsNote, registerAddonTools } from "../../src/main/addons/packs.js";
import type { SandboxResult } from "../../src/main/addons/sandbox.js";
import { documentTools } from "../../src/main/addons/tools/documents.js";
import { pageList, pdfTools, printed } from "../../src/main/addons/tools/pdf.js";
import { cropBox, photoArgs, photoTools } from "../../src/main/addons/tools/photo.js";
import { timed, videoTools } from "../../src/main/addons/tools/video.js";
import { drawingTools } from "../../src/main/addons/tools/drawing.js";
import { column, sheetTools } from "../../src/main/addons/tools/sheets.js";
import { slideTools } from "../../src/main/addons/tools/slides.js";

let base = "";
let folder = "";
let shots = "";
let calls: { id: string; args: string[] }[] = [];
let files: Record<string, string> = {};
let attached: Artifact[] = [];
let tiles: Artifact[] = [];
let produced: Produced[] = [];
let answer: (args: string[], stdin?: string) => Partial<SandboxResult> & { skip?: boolean } = () => ({});
let typed: string[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-addon-tools-")));
  folder = join(base, "Documents");
  shots = join(base, "shots");
  mkdirSync(folder);
  calls = [];
  files = {};
  attached = [];
  tiles = [];
  produced = [];
  typed = [];
  answer = () => ({});
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The file a real program would write for these arguments. */
function written(args: string[]): string[] {
  const after = (flag: string) => (args.includes(flag) ? [args[args.indexOf(flag) + 1]!] : []);
  if (args[0] === "convert") return [args[2]!];
  if (args[0] === "render" && args.includes("--all")) return ["shown/slide-01.png", "shown/slide-02.png"];
  if (args[0] === "render" && !args.includes("--out")) return [args[2]!];
  if (args.includes("export")) return [args[args.indexOf("export") + 1]!];
  // A script that saves names its file itself.
  const saved = args.includes("--script") ? Object.values(files).flatMap((body) => [...body.matchAll(/"tool":"doc_save","args":\{"doc":1,"path":"([^"]+)"/g)].map((m) => m[1]!)) : [];
  return [...saved, ...after("--out"), ...after("--save")];
}

const engines: Engines = async (id, _signal, work) => {
  const dir = mkdtempSync(join(base, "job-"));
  return work({
    dir,
    run: async (args, opts) => {
      calls.push({ id, args: [...args] });
      if (opts?.stdin) typed.push(opts.stdin);
      // What the tool put in the job folder, as the program would read it.
      for (const name of readdirSync(dir)) if (/\.(md|jsonl|json|svg)$/.test(name)) files[name] = readFileSync(join(dir, name), "utf8");
      const said = answer([...args], opts?.stdin);
      if (!said.skip && (said.code ?? 0) === 0) {
        for (const name of written([...args])) {
          mkdirSync(join(dir, name, ".."), { recursive: true });
          writeFileSync(join(dir, name), "made");
        }
      }
      return { code: 0, stdout: "", stderr: "", ...said };
    },
  });
};

const deps = () => ({ engines, roots: new Roots([folder]), shotDir: shots });
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: () => {},
  attach: (a) => attached.push(a),
  gallery: (items) => tiles.push(...items),
  produced: (item) => produced.push(item),
});
const tool = (list: ToolDef[], name: string): ToolDef => list.find((t) => t.name === name)!;
const steps = () => files["steps.jsonl"]!.trim().split("\n").map((line) => JSON.parse(line) as { id: string; params: Record<string, unknown> });

describe("sheet_make", () => {
  const make = () => tool(sheetTools(deps()), "sheet_make");
  const rows = [["Gider", "Ocak", "Toplam"], ["Kira", 12000, "=SUM(B2:B2)"]];

  it("gives the program each cell, formulas as written, and reports what it calculated", async () => {
    answer = (args) => (args[0] === "run" ? { stdout: "Gider  Ocak   Toplam\nKira   12000  12000\n" } : {});
    const out = await make().run({ path: join(folder, "butce.xlsx"), rows, chart: { range: "a1:b2", type: "pie", title: "Giderler" } }, ctx());
    expect(calls).toEqual([{ id: "sheets", args: ["run", "--script", "steps.jsonl", "--out", "out.xlsx", "--print", "A1:C2", "--quiet"] }]);
    expect(steps()).toEqual([
      { id: "cell.set", params: { cell: "A1", input: "Gider" } },
      { id: "cell.set", params: { cell: "B1", input: "Ocak" } },
      { id: "cell.set", params: { cell: "C1", input: "Toplam" } },
      { id: "cell.set", params: { cell: "A2", input: "Kira" } },
      { id: "cell.set", params: { cell: "B2", input: "12000" } },
      { id: "cell.set", params: { cell: "C2", input: "=SUM(B2:B2)" } },
      { id: "home.bold", params: { range: "A1:C1", on: true } },
      { id: "home.autofitColumnWidth", params: { cols: "A:C" } },
      { id: "insert.chart", params: { range: "A1:B2", type: "pie", title: "Giderler", at: "E2" } },
    ]);
    expect(readFileSync(join(folder, "butce.xlsx"), "utf8")).toBe("made");
    expect(produced).toEqual([{ kind: "file", path: join(folder, "butce.xlsx") }]);
    expect(out).toContain("12000  12000");
    expect(out).toContain("2 rows, 3 columns, one pie chart of A1:B2");
  });

  it("shows the table as the program lays it out, and makes the file even when no picture can be drawn", async () => {
    const drawn: string[] = [];
    const withPicture = (picture: (html: string) => Promise<Uint8Array>) => tool(sheetTools({ ...deps(), picture: async (html) => (drawn.push(html), picture(html)) }), "sheet_make");
    await withPicture(async () => new Uint8Array([1, 2, 3])).run({ path: join(folder, "a.xlsx"), rows }, ctx());
    expect(calls.map((c) => c.args)).toContainEqual(["convert", "out.xlsx", "shown.html"]);
    expect(drawn).toEqual(["made"]);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.path.startsWith(join(shots, "addons") + "/")).toBe(true);
    await withPicture(async () => { throw new Error("Nothing was drawn."); }).run({ path: join(folder, "b.xlsx"), rows }, ctx());
    expect(existsSync(join(folder, "b.xlsx"))).toBe(true);
    expect(attached).toHaveLength(1);
  });

  it("never replaces a file, and writes only inside the user's folders", async () => {
    writeFileSync(join(folder, "var.xlsx"), "mine");
    await expect(make().run({ path: join(folder, "var.xlsx"), rows }, ctx())).rejects.toThrow();
    await expect(make().run({ path: join(base, "outside.xlsx"), rows }, ctx())).rejects.toThrow();
    await expect(make().run({ path: join(folder, "butce.csv"), rows }, ctx())).rejects.toThrow(/\.xlsx/);
    expect(calls).toEqual([]);
    expect(readFileSync(join(folder, "var.xlsx"), "utf8")).toBe("mine");
  });

  it("says so when the program fails, and leaves nothing behind", async () => {
    answer = () => ({ code: 1, stderr: "gridcraft-cli: step 3: unknown function `TOPLA`" });
    await expect(make().run({ path: join(folder, "butce.xlsx"), rows }, ctx())).rejects.toThrow(/TOPLA/);
    expect(existsSync(join(folder, "butce.xlsx"))).toBe(false);
    expect(produced).toEqual([]);
  });

  it("points out cells that came out as errors", async () => {
    answer = () => ({ stdout: "Kira  #NAME?\n" });
    expect(await make().run({ path: join(folder, "butce.xlsx"), rows }, ctx())).toMatch(/a formula is wrong/);
  });

  it("names columns past Z", () => {
    expect([0, 25, 26, 701, 702].map(column)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });
});

describe("document_make", () => {
  const list = (paper: "A4" | "Letter" = "A4") => documentTools(deps(), { paper: () => paper });

  it("writes Word on the region's paper and shows the first page", async () => {
    answer = (args) => (args[0] === "info" ? { stdout: '{"pages":3}' } : {});
    const out = await tool(list(), "document_make").run({ path: join(folder, "rapor.docx"), markdown: "# Rapor\n\nMetin." }, ctx());
    expect(files["in.md"]).toBe("# Rapor\n\nMetin.");
    expect(calls.map((c) => c.args)).toEqual([
      ["convert", "in.md", "body.docx"],
      ["run", "--file", "body.docx", "--cmd", 'layout.size={"name":"A4"}', "--save", "out.docx"],
      ["info", "out.docx"],
      ["render", "out.docx", "page.png", "--page", "1", "--scale", "0.8"],
    ]);
    expect(existsSync(join(folder, "rapor.docx"))).toBe(true);
    expect(out).toContain("3 pages");
    // The picture is one the window may show: Vunemi's own folder, a PNG.
    expect(attached).toHaveLength(1);
    expect(attached[0]!.path.startsWith(join(shots, "addons") + "/")).toBe(true);
    expect(attached[0]!.path.endsWith(".png")).toBe(true);
  });

  it("makes a PDF from the same document when asked for one", async () => {
    await tool(list("Letter"), "document_make").run({ path: join(folder, "rapor.pdf"), markdown: "Metin" }, ctx());
    expect(calls.map((c) => c.args.slice(0, 3))).toContainEqual(["convert", "out.docx", "out.pdf"]);
    expect(calls[1]!.args).toContain('layout.size={"name":"Letter"}');
    expect(existsSync(join(folder, "rapor.pdf"))).toBe(true);
  });

  it("refuses an empty document before running anything", async () => {
    await expect(tool(list(), "document_make").run({ path: join(folder, "bos.docx"), markdown: "  " }, ctx())).rejects.toThrow(/empty/);
    expect(calls).toEqual([]);
  });

  it("converts a copy of an existing document, leaving the original alone", async () => {
    writeFileSync(join(folder, "teklif.docx"), "original");
    const out = await tool(list(), "document_convert").run({ path: join(folder, "teklif.docx"), out: join(folder, "teklif.pdf") }, ctx());
    expect(calls).toEqual([{ id: "documents", args: ["convert", "in.docx", "out.pdf"] }]);
    expect(readFileSync(join(folder, "teklif.docx"), "utf8")).toBe("original");
    expect(existsSync(join(folder, "teklif.pdf"))).toBe(true);
    expect(out).toContain("teklif.pdf");
    await expect(tool(list(), "document_convert").run({ path: join(folder, "yok.docx"), out: join(folder, "x.pdf") }, ctx())).rejects.toThrow();
  });
});

describe("slides_make", () => {
  const make = () => tool(slideTools(deps()), "slides_make");
  const cmds = () => calls[0]!.args.filter((_, i, all) => all[i - 1] === "--cmd");

  it("builds the deck slide by slide, without the bullets the model typed", async () => {
    const out = await make().run(
      {
        path: join(folder, "sunum.pptx"),
        theme: "Harbor",
        slides: [
          { title: "Giderler", body: ["Ekim 2026"] },
          { title: "Kalemler", body: ["• Kira", "- Market", "-5 derece"], notes: "Kısa tut" },
          { title: "Dağılım", body: ["yok sayılır"], chart: { type: "pie", categories: ["Kira", "Market"], series: [{ name: "Ekim", values: [12000, 4200] }] } },
        ],
      },
      ctx(),
    );
    expect(cmds()).toEqual([
      'file.new={"blank":true,"theme":"Harbor"}',
      'slide.new={"layout":"title","title":"Giderler","body":"Ekim 2026"}',
      'slide.new={"layout":"titleAndContent","title":"Kalemler","body":"Kira\\nMarket\\n-5 derece"}',
      'slide.notes={"text":"Kısa tut"}',
      'slide.new={"layout":"titleOnly","title":"Dağılım"}',
      'insert.chart={"type":"pie","categories":["Kira","Market"],"series":[{"name":"Ekim","values":[12000,4200]}],"rect":[80,150,800,340]}',
      'chart.options={"title":null}',
    ]);
    expect(calls[0]!.args.slice(-2)).toEqual(["--save", "out.pptx"]);
    expect(existsSync(join(folder, "sunum.pptx"))).toBe(true);
    expect(out).toContain("3 slides, 1 with a chart");
    expect(tiles).toHaveLength(2);
    expect(tiles.every((tile) => tile.path.startsWith(join(shots, "addons") + "/") && tile.path.endsWith(".png"))).toBe(true);
  });

  it("refuses a chart whose values are not numbers", async () => {
    const slides = [{ title: "x", chart: { categories: ["a"], series: [{ name: "s", values: ["çok"] }] } }];
    await expect(make().run({ path: join(folder, "s.pptx"), slides }, ctx())).rejects.toThrow(/numbers/);
    expect(calls).toEqual([]);
  });
});

describe("image_draw", () => {
  const make = () => tool(drawingTools(deps()), "image_draw");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

  it("renders the SVG and shows the picture", async () => {
    await make().run({ path: join(folder, "afis.pdf"), svg }, ctx());
    expect(files["in.svg"]).toBe(svg);
    expect(calls.map((c) => c.args)).toEqual([["convert", "in.svg", "out.png"], ["convert", "in.svg", "out.pdf"]]);
    expect(existsSync(join(folder, "afis.pdf"))).toBe(true);
    expect(attached).toHaveLength(1);
  });

  it("refuses what is not a whole SVG", async () => {
    await expect(make().run({ path: join(folder, "a.png"), svg: "a red circle" }, ctx())).rejects.toThrow(/svg/i);
    await expect(make().run({ path: join(folder, "a.png"), svg: "<svg><rect/>" }, ctx())).rejects.toThrow(/svg/i);
    expect(calls).toEqual([]);
  });

  it("fails when the program leaves no picture, whatever it exits with", async () => {
    answer = () => ({ skip: true, stderr: "SVG parse error: unexpected end of stream" });
    await expect(make().run({ path: join(folder, "a.png"), svg }, ctx())).rejects.toThrow(/parse error/);
    expect(existsSync(join(folder, "a.png"))).toBe(false);
  });
});

describe("PDF tools", () => {
  const list = () => pdfTools(deps());
  const info = (pages: number, encrypted = false) => ({ stdout: JSON.stringify({ pages, encrypted }, null, 2) });

  it("reads page lists as written, and refuses what is outside the file", () => {
    expect(pageList("3, 1-2", 3)).toEqual([3, 1, 2]);
    expect(() => pageList("4", 3)).toThrow(/3 pages/);
    expect(() => pageList("2-1", 3)).toThrow();
    expect(() => pageList("all", 3)).toThrow(/1,3,5-7/);
    expect(() => pageList("", 3)).toThrow();
  });

  it("reads the objects the program prints one after another", () => {
    expect(printed('{\n  "doc": 1\n}\n{\n  "fields": [\n    {\n      "name": "ad"\n    }\n  ]\n}\n')).toEqual([{ doc: 1 }, { fields: [{ name: "ad" }] }]);
    expect(printed("pdfcraft-cli: no such file")).toEqual([]);
  });

  it("takes pages out into a new file, ranges written out page by page", async () => {
    writeFileSync(join(folder, "tum.pdf"), "original");
    answer = (args) => (args[0] === "info" ? info(5) : {});
    const out = await tool(list(), "pdf_extract").run({ path: join(folder, "tum.pdf"), pages: "5,1-2", out: join(folder, "secilen.pdf") }, ctx());
    expect(calls.map((c) => c.args)).toContainEqual(["extract", "in.pdf", "--pages", "5,1,2", "--out", "out.pdf"]);
    expect(readFileSync(join(folder, "tum.pdf"), "utf8")).toBe("original");
    expect(existsSync(join(folder, "secilen.pdf"))).toBe(true);
    expect(out).toContain("secilen.pdf: 5 pages");
    expect(attached).toHaveLength(1);
  });

  it("turns every page when none is named", async () => {
    writeFileSync(join(folder, "tum.pdf"), "x");
    answer = (args) => (args[0] === "info" ? info(3) : {});
    await tool(list(), "pdf_rotate").run({ path: join(folder, "tum.pdf"), degrees: 90, out: join(folder, "donuk.pdf") }, ctx());
    expect(calls.map((c) => c.args)).toContainEqual(["edit", "in.pdf", "--out", "out.pdf", "--rotate", "1,2,3:90"]);
    await expect(tool(list(), "pdf_rotate").run({ path: join(folder, "tum.pdf"), degrees: 45, out: join(folder, "x.pdf") }, ctx())).rejects.toThrow(/90, 180 or 270/);
  });

  it("does not open a PDF that needs a password", async () => {
    writeFileSync(join(folder, "kilitli.pdf"), "x");
    writeFileSync(join(folder, "acik.pdf"), "x");
    answer = (args) => (args[0] === "info" ? info(2, args[1] === "in-2.pdf") : {});
    await expect(tool(list(), "pdf_combine").run({ paths: [join(folder, "acik.pdf"), join(folder, "kilitli.pdf")], out: join(folder, "hepsi.pdf") }, ctx())).rejects.toThrow(/password/);
    expect(calls.some((c) => c.args[0] === "combine")).toBe(false);
    expect(existsSync(join(folder, "hepsi.pdf"))).toBe(false);
  });

  it("lists a form's fields as someone else's words, and fills them into a new file", async () => {
    writeFileSync(join(folder, "form.pdf"), "x");
    const fields = JSON.stringify({ count: 1, fields: [{ name: "ad", type: "text", page: 1, value: "Ayşe" }] }, null, 2);
    answer = (args) => (args[0] === "info" ? info(1) : args.includes("--script") ? { stdout: `{\n  "doc": 1\n}\n${fields}\n` } : {});
    const form = tool(list(), "pdf_form");
    expect(form.untrustedOutput).toBe(true);
    expect(form.classify?.({ path: "x" })).toBe("read");
    expect(form.classify?.({ path: "x", values: {} })).toBe("write-local");
    expect(await form.run({ path: join(folder, "form.pdf") }, ctx())).toContain('- ad (text, page 1): "Ayşe"');
    expect(JSON.parse(files["steps.json"]!)).toEqual([{ tool: "doc_open", args: { path: "in.pdf" } }, { tool: "form_fields", args: { doc: 1 } }]);

    await form.run({ path: join(folder, "form.pdf"), values: { ad: "Ayşe", onay: true }, out: join(folder, "dolu.pdf") }, ctx());
    expect(JSON.parse(files["steps.json"]!)).toEqual([
      { tool: "doc_open", args: { path: "in.pdf" } },
      { tool: "form_fill", args: { doc: 1, values: { ad: "Ayşe", onay: true } } },
      { tool: "doc_save", args: { doc: 1, path: "out.pdf" } },
      { tool: "form_fields", args: { doc: 1 } },
    ]);
    expect(existsSync(join(folder, "dolu.pdf"))).toBe(true);
  });
});

describe("photo_edit", () => {
  const make = () => tool(photoTools(deps()), "photo_edit");
  const size = { width: 4000, height: 3000 };

  it("crops by shape from the middle, or by pixels inside the picture", () => {
    expect(cropBox({ ratio: "1:1" }, size)).toEqual({ x: 500, y: 0, width: 3000, height: 3000 });
    expect(cropBox({ ratio: "9:16" }, size)).toEqual({ x: 1156, y: 0, width: 1688, height: 3000 });
    expect(cropBox({ x: 10, y: 20, width: 100, height: 50 }, size)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(() => cropBox({ x: 3990, y: 0, width: 100, height: 50 }, size)).toThrow(/4000 by 3000/);
    expect(() => cropBox({ ratio: "square" }, size)).toThrow(/1:1/);
    expect(cropBox(undefined, size)).toBeNull();
  });

  it("applies the changes in one order, keeping the shape when one side is given", () => {
    const { args, did } = photoArgs({ resize: { width: 1000 }, rotate: 90, crop: { ratio: "1:1" }, brightness: 20, contrast: -40, saturation: 250, flip: "horizontal" }, size);
    expect(args).toEqual([
      "--cmd", "image.crop", "--params", '{"x":500,"y":0,"width":3000,"height":3000}',
      "--cmd", "image.imageRotation.90cw",
      "--cmd", "image.imageRotation.flipCanvasHorizontal",
      "--cmd", "image.imageSize", "--params", '{"width":1000,"height":1000}',
      "--cmd", "image.adjustments.brightnessContrast", "--params", '{"brightness":30,"contrast":-20}',
      "--cmd", "image.adjustments.vibrance", "--params", '{"saturation":100}',
    ]);
    expect(did[0]).toBe("cropped to 3000 by 3000");
    // After a quarter turn the sides have changed places.
    expect(photoArgs({ rotate: 270, resize: { height: 400 } }, size).args.slice(-2)).toEqual(["--params", '{"width":300,"height":400}']);
    expect(() => photoArgs({ rotate: 45 }, size)).toThrow(/90, 180 or 270/);
  });

  it("makes a new picture and leaves the one it was given alone", async () => {
    writeFileSync(join(folder, "foto.heic"), "original");
    answer = (args) => (args[0] === "info" ? { stdout: JSON.stringify(args[1] === "in.heic" ? size : { width: 3000, height: 3000 }) } : {});
    const out = await make().run({ path: join(folder, "foto.heic"), out: join(folder, "kare.jpg"), crop: { ratio: "1:1" } }, ctx());
    expect(calls[1]!.args).toEqual(["run", "in.heic", "--cmd", "image.crop", "--params", '{"x":500,"y":0,"width":3000,"height":3000}', "--out", "out.jpg", "--quality", "90"]);
    expect(readFileSync(join(folder, "foto.heic"), "utf8")).toBe("original");
    expect(existsSync(join(folder, "kare.jpg"))).toBe(true);
    expect(out).toContain("Before: 4000 by 3000 pixels; now: 3000 by 3000");
    expect(attached).toHaveLength(1);
  });

  it("only converts when no change is asked for", async () => {
    writeFileSync(join(folder, "foto.png"), "x");
    answer = (args) => (args[0] === "info" ? { stdout: JSON.stringify(size) } : {});
    expect(await make().run({ path: join(folder, "foto.png"), out: join(folder, "foto.webp") }, ctx())).toContain("format converted");
    expect(calls[1]!.args).toEqual(["convert", "in.png", "out.webp", "--quality", "90"]);
  });
});

describe("video tools", () => {
  const list = () => videoTools(deps());
  const TICKS = 254_016_000_000;
  const media = (seconds: number) => ({ stdout: JSON.stringify({ duration: seconds * TICKS, audio_streams: [{}], video: { width: 1920, height: 1080, frame_rate: { num: 30, den: 1 } } }) });
  /** Stands in for the program: every command accepted, the import numbered, the clips as placed. */
  const film = (args: string[], stdin?: string) => {
    if (args[0] === "probe") return media(args[1] === "out.mp4" ? 7 : 10);
    if (args.includes("inspect")) return { stdout: JSON.stringify({ duration: 7 * TICKS, video: [{ items: [{ clip: 11 }, { clip: 12 }] }], audio: [{ items: [{ clip: 21 }, { clip: 22 }] }, { items: [{ clip: 31 }] }] }) };
    if (stdin) {
      const answers = stdin.trim().split("\n").map((line) => {
        const step = JSON.parse(line) as { id: string; params: { paths?: string[] } };
        return { ok: true, result: step.id === "file.import" ? { items: step.params.paths!.map((_, i) => i + 1), errors: [] } : null };
      });
      return { stdout: answers.map((one) => JSON.stringify(one)).join("\n") };
    }
    return {};
  };
  const sent = () => typed.flatMap((block) => block.trim().split("\n").map((line) => JSON.parse(line) as { id: string; params: Record<string, unknown> }));

  it("keeps titles and captions inside the video", () => {
    expect(timed([{ text: "Giriş", at: 0 }, { text: "Son", at: 9, seconds: 5 }, { text: "Sonrası", at: 12 }, { text: " ", at: 1 }], 10, 3)).toEqual([
      { text: "Giriş", at: 0, seconds: 3 },
      { text: "Son", at: 9, seconds: 1 },
    ]);
    expect(timed(undefined, 10, 3)).toEqual([]);
  });

  it("says how long a video is", async () => {
    writeFileSync(join(folder, "a.mov"), "x");
    answer = film;
    expect(await tool(list(), "video_info").run({ path: join(folder, "a.mov") }, ctx())).toContain("10.0 seconds, 1920 by 1080, 30.00 frames a second, with sound");
  });

  it("cuts the clips together in the program's own units, and exports", async () => {
    writeFileSync(join(folder, "a.mp4"), "x");
    writeFileSync(join(folder, "b.mov"), "x");
    writeFileSync(join(folder, "muzik.mp3"), "x");
    answer = film;
    const out = await tool(list(), "video_make").run(
      {
        out: join(folder, "kurgu.mp4"),
        clips: [{ path: join(folder, "a.mp4"), start: 2, end: 6 }, { path: join(folder, "b.mov"), end: 3 }],
        fade: true,
        titles: [{ text: "Tatil", at: 0, seconds: 2 }],
        captions: [{ text: "İlk gün", at: 1 }, { text: "çok geç", at: 60 }],
        music: join(folder, "muzik.mp3"),
      },
      ctx(),
    );
    expect(sent()).toEqual([
      { id: "file.import", params: { paths: ["clip-1.mp4", "clip-2.mov", "music.mp3"] } },
      { id: "file.newSequence", params: { name: "Vunemi", width: 1920, height: 1080, fps: 30 } },
      { id: "timeline.place", params: { item: 1, track: "V1", seconds: 0, insert: false, sourceIn: 2 * TICKS, duration: 4 * TICKS } },
      { id: "timeline.place", params: { item: 2, track: "V1", seconds: 4, insert: false, sourceIn: 0, duration: 3 * TICKS } },
      { id: "timeline.place", params: { item: 3, track: "A2", seconds: 0, insert: false, duration: 7 * TICKS } },
      { id: "sequence.applyVideoTransition", params: { clip: 12, effect: "cross_dissolve", frames: 12, edge: "in" } },
      { id: "clip.audioGain", params: { clips: [31], mode: "adjust", db: -12 } },
      { id: "graphics.newText", params: { text: "Tatil", position: [115, 216], size: 108, newClip: true, seconds: 2, time: 0 } },
      { id: "captions.newTrack", params: { format: "Subtitle" } },
      { id: "captions.add", params: { text: "İlk gün", seconds: 1, durationSeconds: 2.5 } },
    ]);
    expect(calls.map((c) => c.args)).toContainEqual(["--project", "edit.fcproj", "export", "out.mp4", "--format", "h264", "--settings", '{"burnCaptions":true}']);
    expect(existsSync(join(folder, "kurgu.mp4"))).toBe(true);
    expect(out).toContain("7.0 seconds, 1920 by 1080, from 2 clips, with 1 title, 1 caption, music, cross-fades");
  });

  it("refuses a cut that leaves nothing, before the program is asked to edit", async () => {
    writeFileSync(join(folder, "a.mp4"), "x");
    answer = film;
    await expect(tool(list(), "video_make").run({ out: join(folder, "k.mp4"), clips: [{ path: join(folder, "a.mp4"), start: 30 }] }, ctx())).rejects.toThrow(/10\.0 seconds long/);
    expect(typed).toEqual([]);
  });

  it("stops when the program refuses a step, and makes no file", async () => {
    writeFileSync(join(folder, "a.mp4"), "x");
    answer = (args, stdin) => (stdin?.includes("timeline.place") ? { stdout: JSON.stringify({ ok: false, error: "no track V1" }) } : film(args, stdin));
    await expect(tool(list(), "video_make").run({ out: join(folder, "k.mp4"), clips: [{ path: join(folder, "a.mp4") }] }, ctx())).rejects.toThrow(/no track V1/);
    expect(calls.some((c) => c.args.includes("export"))).toBe(false);
    expect(existsSync(join(folder, "k.mp4"))).toBe(false);
  });
});

describe("add-on packs", () => {
  const register = (installed: Set<string>) => {
    const tools = new ToolRegistry();
    const made = registerAddonTools({ tools, ...deps(), paper: () => "A4", installed: (id) => installed.has(id) });
    return { tools, sync: made.sync };
  };

  it("offers a pack's tools only while its add-on is installed", () => {
    const installed = new Set<string>();
    const { tools, sync } = register(installed);
    expect(tools.get("sheet_make")).toBeUndefined();
    installed.add("sheets");
    sync();
    expect(tools.get("sheet_make")?.onDemand).toBe("sheets");
    expect(tools.get("slides_make")).toBeUndefined();
    installed.delete("sheets");
    sync();
    expect(tools.get("sheet_make")).toBeUndefined();
  });

  it("refuses a path that cannot work before the user is asked anything", async () => {
    const { tools } = register(new Set(PACKS.map((p) => p.id)));
    // Every add-on tool takes a path: each one tries it before its card.
    for (const pack of PACKS) for (const made of pack.tools(deps(), { paper: () => "A4" })) expect(typeof made.check, made.name).toBe("function");
    const sheet = tools.get("sheet_make")!;
    // A home folder the model made up: outside the open folders, and said so.
    expect(await sheet.check!({ path: "/Users/someone-else/Downloads/giderler.xlsx", rows: [["a"]] })).toContain(folder);
    expect(await sheet.check!({ path: join(folder, "giderler.xlsx"), rows: [["a"]] })).toBeNull();
    writeFileSync(join(folder, "var.xlsx"), "mine");
    expect(await sheet.check!({ path: join(folder, "var.xlsx"), rows: [["a"]] })).toBeTruthy();
    const video = tools.get("video_make")!;
    writeFileSync(join(folder, "a.mp4"), "x");
    expect(await video.check!({ out: join(folder, "k.mp4"), clips: [{ path: join(folder, "a.mp4") }] })).toBeNull();
    expect(await video.check!({ out: join(folder, "k.mp4"), clips: [{ path: join(folder, "yok.mp4") }] })).toBeTruthy();
    const form = tools.get("pdf_form")!;
    writeFileSync(join(folder, "form.pdf"), "x");
    expect(await form.check!({ path: join(folder, "form.pdf") })).toBeNull();
    expect(await form.check!({ path: join(folder, "form.pdf"), values: { ad: "x" } })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("gives every pack an area with a guide, and no two the same name", () => {
    const areas = addonAreas([folder]);
    expect(areas.map((a) => a.id)).toEqual(PACKS.map((p) => p.area));
    // Every guide ends by saying where files may go, and how the home folder is written.
    for (const area of areas) expect(area.guide, area.id).toContain(`open to you: ${folder}. Write the home folder as ~`);
    expect(pathsNote([join(homedir(), "Downloads")])).toContain("open to you: ~/Downloads.");
    expect(new Set(areas.map((a) => a.id)).size).toBe(areas.length);
    for (const area of areas) expect(area.guide, area.id).toBeTruthy();
    // "photos" is the Photos library's group in the Mac apps connection.
    expect(areas.map((a) => a.id)).not.toContain("photos");
  });

  it("tells the model which add-ons are not there, and nothing once all are", () => {
    expect(addonInstructions((id) => id !== "slides")).toBe("Add-ons not downloaded yet: presentations. If a request needs one, tell the user to add it in Settings › Add-ons.");
    expect(addonInstructions(() => true)).toBe("");
  });

  it("opens the right area for a request, in the app's languages", () => {
    const wanted = (id: string, request: string) => PACKS.find((p) => p.id === id)!.wanted.test(request);
    expect(wanted("slides", "Yarınki toplantı için bir sunum hazırla")).toBe(true);
    expect(wanted("slides", "明日の会議のプレゼンを作って")).toBe(true);
    expect(wanted("sheets", "bunu xlsx olarak kaydet")).toBe(true);
    expect(wanted("drawing", "Doğum günü için bir afiş çiz")).toBe(true);
    expect(wanted("drawing", "posterior analysis")).toBe(false);
  });
});

describe("add-on jobs", () => {
  it("runs the program in a folder of its own and removes the folder afterwards", async () => {
    const seen: { program: string; job: string; home: string; engineDir: string }[] = [];
    const run = createEngines({
      addons: { binary: (id) => (id === "sheets" ? "/engines/gridcraft-cli" : null), engineDir: () => "/engines" },
      home: "/Users/someone",
      jobsDir: join(base, "jobs"),
      run: async (program, _args, o) => {
        seen.push({ program, job: o.job, home: o.home, engineDir: o.engineDir });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const dir = await run("sheets", new AbortController().signal, async (job) => {
      await job.run(["version"]);
      return job.dir;
    });
    expect(seen).toEqual([{ program: "/engines/gridcraft-cli", job: dir, home: "/Users/someone", engineDir: "/engines" }]);
    expect(dir.startsWith(realpathSync(join(base, "jobs")) + "/")).toBe(true);
    expect(existsSync(dir)).toBe(false);
    await expect(run("slides", new AbortController().signal, async () => "ran")).rejects.toThrow(/not installed/);
  });
});
