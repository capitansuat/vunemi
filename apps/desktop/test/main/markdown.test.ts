/**
 * Files to Markdown. MarkItDown itself is not run here: a stand-in answers
 * as scripts/markitdown/convert.py does, one line of JSON a file. What is
 * tested is this side: what it is asked, that the .md files land only where
 * the user's folders allow, that nothing is ever replaced, and that a
 * failure is named for the file it belongs to.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry, type Produced, type ToolContext, type ToolDef } from "@vunemi/agent-core";
import { Roots } from "@vunemi/files";
import type { Engines } from "../../src/main/addons/jobs.js";
import { MARKDOWN_WANTED, markdownArea, markdownTools, markitdownDir, registerMarkdownTools, reports, why } from "../../src/main/markdown.js";

let base = "";
let folder = "";
let calls: string[][] = [];
let produced: Produced[] = [];
/** What the stand-in does with one input: the Markdown it writes, or an error. */
let convert: (input: string) => { markdown: string } | { error: string } = (input) => ({ markdown: `# ${input}` });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-markdown-")));
  folder = join(base, "Documents");
  mkdirSync(folder);
  calls = [];
  produced = [];
  convert = (input) => ({ markdown: `# ${input}` });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const engines: Engines<"markdown"> = async (id, _signal, work) => {
  expect(id).toBe("markdown");
  const dir = mkdtempSync(join(base, "job-"));
  return work({
    dir,
    run: async (args) => {
      calls.push([...args]);
      const lines: string[] = [];
      for (let i = 0; i < args.length; i += 2) {
        const said = convert(args[i]!);
        if ("error" in said) {
          lines.push(JSON.stringify({ ok: false, error: said.error }));
          continue;
        }
        expect(existsSync(join(dir, args[i]!))).toBe(true);
        mkdirSync(dirname(join(dir, args[i + 1]!)), { recursive: true });
        writeFileSync(join(dir, args[i + 1]!), said.markdown);
        lines.push(JSON.stringify({ ok: true, chars: said.markdown.length }));
      }
      return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    },
  });
};

const deps = () => ({ engines, roots: new Roots([folder]) });
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: () => {},
  attach: () => {},
  produced: (item) => produced.push(item),
});
const tool = (name: string): ToolDef => markdownTools(deps()).find((t) => t.name === name)!;
const put = (name: string, body = "original") => (writeFileSync(join(folder, name), body), join(folder, name));

describe("markdown_convert", () => {
  it("converts every file in one run, puts each .md next to its original, and leaves the original as it was", async () => {
    const report = put("Rapor.docx");
    const deck = put("Sunum.pptx");
    const out = await tool("markdown_convert").run({ paths: [report, deck] }, ctx());
    expect(calls).toEqual([[join("in", "0", "Rapor.docx"), join("out", "0.md"), join("in", "1", "Sunum.pptx"), join("out", "1.md")]]);
    expect(readFileSync(join(folder, "Rapor.md"), "utf8")).toBe(`# ${join("in", "0", "Rapor.docx")}`);
    expect(readFileSync(join(folder, "Sunum.md"), "utf8")).toBe(`# ${join("in", "1", "Sunum.pptx")}`);
    expect(readFileSync(report, "utf8")).toBe("original");
    expect(produced).toEqual([{ kind: "file", path: join(folder, "Rapor.md") }, { kind: "file", path: join(folder, "Sunum.md") }]);
    expect(out).toContain(`Created ${join(folder, "Rapor.md")} (17 characters).`);
  });

  it("saves into the folder given, making it when it is not there yet", async () => {
    await tool("markdown_convert").run({ paths: [put("Bütçe.xlsx")], folder: join(folder, "md") }, ctx());
    expect(existsSync(join(folder, "md", "Bütçe.md"))).toBe(true);
  });

  it("never replaces a file: a name that is taken gets the original's kind in it", async () => {
    const report = put("Rapor.docx");
    put("Rapor.md", "mine");
    await tool("markdown_convert").run({ paths: [report] }, ctx());
    expect(readFileSync(join(folder, "Rapor.md"), "utf8")).toBe("mine");
    expect(existsSync(join(folder, "Rapor.docx.md"))).toBe(true);
    // Both names taken: refused, with what to do instead.
    expect(await tool("markdown_convert").check!({ paths: [report] })).toMatch(/Rapor\.docx\.md.*folder/);
  });

  it("gives a .docx and a .pdf of the same name a .md each, in one call", async () => {
    // Asked for rapor.docx and rapor.pdf at once, the model was refused and tried five times.
    await tool("markdown_convert").run({ paths: [put("rapor.docx"), put("rapor.pdf"), put("tablo.xlsx")] }, ctx());
    expect(readdirSync(folder).filter((name) => name.endsWith(".md")).sort()).toEqual(["rapor.docx.md", "rapor.pdf.md", "tablo.md"]);
  });

  it("asks for nothing that cannot be done", async () => {
    const convert = tool("markdown_convert");
    expect(await convert.check!({ paths: [join(base, "x.docx")] })).not.toBeNull();
    expect(await convert.check!({ paths: [put("foto.jpg")] })).toMatch(/\.docx/);
    expect(await convert.check!({ paths: [join(folder, "yok.pdf")] })).not.toBeNull();
    expect(await convert.check!({ paths: [put("b.pdf")], folder: join(base, "elsewhere") })).not.toBeNull();
    expect(await convert.check!({ paths: [] })).toMatch(/paths/);
    expect(await convert.check!({ paths: Array.from({ length: 41 }, (_, i) => `f${i}.pdf`) })).toMatch(/At most 40/);
    expect(calls).toEqual([]);
  });

  it("names the file that failed and still saves the others", async () => {
    convert = (input) => (input.endsWith("bozuk.pdf") ? { error: "PDFSyntaxError: No /Root object!" } : { markdown: "metin" });
    const out = await tool("markdown_convert").run({ paths: [put("bozuk.pdf"), put("iyi.docx")] }, ctx());
    expect(out).toMatch(/bozuk\.pdf: not converted\..*No \/Root object/);
    expect(out).toContain("iyi.md");
    expect(existsSync(join(folder, "bozuk.md"))).toBe(false);
    expect(existsSync(join(folder, "iyi.md"))).toBe(true);
  });

  it("says a scanned PDF has no text instead of saving an empty file, and fails when nothing was converted", async () => {
    convert = () => ({ markdown: "  \n" });
    await expect(tool("markdown_convert").run({ paths: [put("tarama.pdf")] }, ctx())).rejects.toThrow(/scanned PDF/);
    expect(existsSync(join(folder, "tarama.md"))).toBe(false);
    expect(produced).toEqual([]);
  });

  it("reports a program that stopped early for every file it did not answer for", async () => {
    const quiet: Engines<"markdown"> = async (_id, _signal, work) => work({ dir: mkdtempSync(join(base, "job-")), run: async () => ({ code: 1, stdout: "", stderr: "Killed: 9" }) });
    const convert = markdownTools({ engines: quiet, roots: new Roots([folder]) }).find((t) => t.name === "markdown_convert")!;
    await expect(convert.run({ paths: [put("a.docx")] }, ctx())).rejects.toThrow(/Killed: 9/);
  });
});

describe("markdown_read", () => {
  it("reads a file as Markdown without saving anything, as untrusted text", async () => {
    const read = tool("markdown_read");
    expect(read.actionClass).toBe("read");
    expect(read.untrustedOutput).toBe(true);
    expect(await read.run({ path: put("Rapor.docx") }, ctx())).toBe(`# ${join("in", "0", "Rapor.docx")}`);
    expect(readdirSync(folder)).toEqual(["Rapor.docx"]);
    expect(produced).toEqual([]);
  });

  it("sends a file that is already text to files_read", async () => {
    // The model asked markdown_read for rapor.md three times.
    expect(await tool("markdown_read").check!({ path: put("rapor.md", "# R") })).toMatch(/already text.*files_read/);
    expect(calls).toEqual([]);
  });

  it("gives a long file in parts", async () => {
    convert = () => ({ markdown: "x".repeat(70_000) });
    const first = await tool("markdown_read").run({ path: put("uzun.pdf") }, ctx());
    expect(first).toContain("Call again with offset 60000");
    const second = await tool("markdown_read").run({ path: join(folder, "uzun.pdf"), offset: 60_000 }, ctx());
    expect(second).toBe("x".repeat(10_000));
  });
});

describe("files to Markdown in Vunemi", () => {
  it("reads the program's answers, one line a file, ignoring anything else it printed", () => {
    expect(reports('noise\n{"ok": true, "chars": 3}\n{"ok": false, "error": "E"}\n[1]\n')).toEqual([{ ok: true }, { ok: false, error: "E" }]);
  });

  it("says why a file wasn't converted from the start of the reason, short", () => {
    const csv = "FileConversionException: File conversion failed after 2 attempts:\n - CsvConverter threw UnicodeDecodeError with message: 'ascii' codec can't decode byte 0xe2 in position 113871: ordinal not in range(128). The charset may have been automatically guessed incorrectly. If you didn't specify the charset, please retry with an explicitly defined one.\n - PlainTextConverter threw UnicodeDecodeError with message: 'ascii' codec can't decode byte 0xe2";
    expect(why(csv)).toBe(`${"CsvConverter threw UnicodeDecodeError with message: 'ascii' codec can't decode byte 0xe2 in position 113871: ordinal not in range(128). The charset may have been automatically guessed incorrectly. If ".slice(0, 199)}…`);
    expect(why("PDFSyntaxError: No /Root object!")).toBe("PDFSyntaxError: No /Root object!");
  });

  it("finds the program in the app's resources, or in the build cache, and only on a Mac", () => {
    const resources = join(base, "Resources");
    mkdirSync(join(resources, "markitdown"), { recursive: true });
    expect(markitdownDir({ packaged: true, resourcesPath: resources, home: base, darwin: true })).toBeNull();
    writeFileSync(join(resources, "markitdown", "convert"), "#!/bin/sh\n");
    expect(markitdownDir({ packaged: true, resourcesPath: resources, home: base, darwin: true })).toBe(join(resources, "markitdown"));
    expect(markitdownDir({ packaged: true, resourcesPath: resources, home: base, darwin: false })).toBeNull();
    expect(markitdownDir({ packaged: false, resourcesPath: resources, home: base, darwin: true })).toBeNull();
  });

  it("offers the tools only when this build has the program, in their own area", () => {
    const without = new ToolRegistry();
    registerMarkdownTools(without, { ...deps(), available: false });
    expect(without.get("markdown_convert")).toBeUndefined();
    const tools = new ToolRegistry();
    registerMarkdownTools(tools, { ...deps(), available: true });
    expect(tools.get("markdown_convert")?.onDemand).toBe("markdown");
    expect(tools.get("markdown_read")?.onDemand).toBe("markdown");
    // Its .md files are MarkItDown's, not the model's: reading one back skips the source review.
    expect(tools.get("markdown_convert")?.convertsFiles).toBe(true);
    expect(tools.get("markdown_read")?.convertsFiles).toBeUndefined();
    expect(markdownArea([folder]).guide).toContain("markdown_convert");
  });

  it("opens for a request about Markdown, not for any file that ends in .md", () => {
    for (const asked of ["bu dosyaları markdowna çevir", "PDF'i md'ye çevir", "md formatına dönüştür", "convert these to Markdown"]) expect(MARKDOWN_WANTED.test(asked), asked).toBe(true);
    for (const asked of ["edit notes.mdx", "md5 hash", "amd işlemci", "cmd aç"]) expect(MARKDOWN_WANTED.test(asked), asked).toBe(false);
  });
});
