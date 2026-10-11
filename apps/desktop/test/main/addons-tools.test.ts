/**
 * The tools add-ons give the model. The programs themselves are not run
 * here: a stand-in records what it was asked and leaves the file a real one
 * would. What is tested is this side: what the program is asked to do, that
 * its work lands only where the user's folders allow, that nothing is ever
 * replaced, and that a failure is reported as one.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry, type Artifact, type Produced, type ToolContext, type ToolDef } from "@vunemi/agent-core";
import { Roots } from "@vunemi/files";
import { createEngines, type Engines } from "../../src/main/addons/jobs.js";
import { PACKS, addonAreas, addonInstructions, registerAddonTools } from "../../src/main/addons/packs.js";
import type { SandboxResult } from "../../src/main/addons/sandbox.js";
import { documentTools } from "../../src/main/addons/tools/documents.js";
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
let answer: (args: string[]) => Partial<SandboxResult> & { skip?: boolean } = () => ({});

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
  answer = () => ({});
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The file a real program would write for these arguments. */
function written(args: string[]): string[] {
  const after = (flag: string) => (args.includes(flag) ? [args[args.indexOf(flag) + 1]!] : []);
  if (args[0] === "convert") return [args[2]!];
  if (args[0] === "render" && args.includes("--all")) return ["shown/slide-01.png", "shown/slide-02.png"];
  if (args[0] === "render") return [args[2]!];
  return [...after("--out"), ...after("--save")];
}

const engines: Engines = async (id, _signal, work) => {
  const dir = mkdtempSync(join(base, "job-"));
  return work({
    dir,
    run: async (args) => {
      calls.push({ id, args: [...args] });
      // What the tool put in the job folder, as the program would read it.
      for (const name of readdirSync(dir)) if (/\.(md|jsonl|svg)$/.test(name)) files[name] = readFileSync(join(dir, name), "utf8");
      const said = answer([...args]);
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

  it("gives every pack an area with a guide, and no two the same name", () => {
    const areas = addonAreas();
    expect(areas.map((a) => a.id)).toEqual(PACKS.map((p) => p.area));
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
