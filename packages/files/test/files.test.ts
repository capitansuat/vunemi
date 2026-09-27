import { t } from "@vunemi/i18n";
/**
 * The file tools, read as a list of ways out of the sandbox — because that is
 * what they are. Each test is one escape that has to fail, or one change that
 * has to be undoable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Produced, ToolContext, ToolDef } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileTools, PathRefused, Roots } from "../src/index.js";
import { similarNames, spotlightQuery } from "../src/tools.js";

/** The smallest PDF with one line of real text, enough for PDFKit to read back. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("file tools", () => {
  let home = "";
  let root = "";
  let tools: Map<string, ToolDef>;
  let undos: { label: string; undo: () => Promise<void> }[];
  let made: Produced[];

  const ctx = (): ToolContext => ({
    signal: new AbortController().signal,
    handoff: async () => true,
    offerUndo: (label, undo) => undos.push({ label, undo }),
    attach: () => {},
    produced: (item) => made.push(item),
  });

  const call = (name: string, args: Record<string, unknown>) =>
    tools.get(name)!.run(args as never, ctx());

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "vunemi-files-"));
    root = join(home, "Belgeler");
    mkdirSync(root, { recursive: true });
    undos = [];
    made = [];
    tools = new Map(
      createFileTools({ roots: new Roots([root]), shadowDir: join(home, "shadow") }).map((t) => [t.name, t]),
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // -- the walls ---------------------------------------------------------------

  it("points a bare name to the open folder that has it, without reading it", async () => {
    const downloads = join(home, "Downloads");
    mkdirSync(downloads);
    writeFileSync(join(downloads, "fatura.txt"), "x");
    const two = new Map(createFileTools({ roots: new Roots([root, downloads]), shadowDir: join(home, "shadow") }).map((t) => [t.name, t]));
    await expect(two.get("files_read")!.run({ path: "fatura.txt" } as never, ctx())).rejects.toThrow(/Downloads\/fatura\.txt/);
  });

  it("reads only the start of a large text file, and says how big it is", async () => {
    // "ş" is two bytes: the cut can fall inside one, which is dropped rather than shown as garbage.
    writeFileSync(join(root, "büyük.txt"), "ş".repeat(400_000));
    const out = await call("files_read", { path: join(root, "büyük.txt") });
    expect(out).toMatch(/^ş{120000}\n\n\[… the start of the file; it is .* in all\]$/);
    writeFileSync(join(root, "küçük.txt"), "merhaba");
    expect(await call("files_read", { path: join(root, "küçük.txt") })).toBe("merhaba");
  });

  it("won't hand a converter an address or protocol, or lift ffmpeg's own guards", async () => {
    // Checked before the converter's path is: refused whether ffmpeg is installed or not.
    for (const arg of ["tcp:evil.example:9000", "pipe:1", "udp:10.0.0.1:5000", "http:evil.example"]) {
      await expect(call("system_run", { command: "sips", args: ["-s", "format", "png", arg] })).rejects.toThrow(PathRefused);
    }
    await expect(call("system_run", { command: "sips", args: ["-safe", "0"] })).rejects.toThrow(PathRefused);
  });

  it("marks what a converter prints as someone else's words", () => {
    expect(tools.get("system_run")!.untrustedOutput).toBe(true);
  });

  it("shows an image instead of calling it unreadable", async () => {
    const attached: unknown[] = [];
    writeFileSync(join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const out = await tools.get("files_read")!.run({ path: join(root, "photo.png") } as never, { ...ctx(), attach: (a) => attached.push(a) });
    expect(out).toMatch(/^Image: /);
    expect(attached).toEqual([expect.objectContaining({ kind: "image", path: realpathSync(join(root, "photo.png")) })]);
  });

  it("refuses a path outside the open folders", async () => {
    await expect(call("files_read", { path: "/etc/hosts" })).rejects.toThrow(PathRefused);
    await expect(call("files_read", { path: join(homedir(), ".ssh", "id_rsa") })).rejects.toThrow(/dışında|gizli/);
  });

  it("refuses to climb out with ..", async () => {
    writeFileSync(join(home, "secret.txt"), "dışarıda");
    await expect(call("files_read", { path: "../secret.txt" })).rejects.toThrow(PathRefused);
    await expect(call("files_read", { path: join(root, "..", "secret.txt") })).rejects.toThrow(PathRefused);
  });

  it("refuses to follow a symlink out of the open folders", async () => {
    writeFileSync(join(home, "secret.txt"), "dışarıda");
    symlinkSync(join(home, "secret.txt"), join(root, "kisayol.txt"));
    symlinkSync(home, join(root, "yukari"));
    await expect(call("files_read", { path: "kisayol.txt" })).rejects.toThrow(PathRefused);
    await expect(call("files_read", { path: "yukari/secret.txt" })).rejects.toThrow(PathRefused);
  });

  it("refuses hidden files, where credentials live", async () => {
    writeFileSync(join(root, ".env"), "TOKEN=abc");
    await expect(call("files_read", { path: ".env" })).rejects.toThrow(/gizli/);
  });

  it("does not write into a symlinked folder that points outside", async () => {
    symlinkSync(home, join(root, "yukari"));
    await expect(call("files_write", { path: "yukari/yeni.txt", content: "x" })).rejects.toThrow(PathRefused);
    expect(existsSync(join(home, "yeni.txt"))).toBe(false);
  });

  it("understands the folder names Finder shows, not just the ones on disk", () => {
    // These only resolve when the real folder is open anyway, which is why
    // accepting them costs nothing.
    const real = new Roots([join(homedir(), "Documents"), join(homedir(), "Desktop")]);
    expect(real.resolve("Belgeler/rapor.txt")).toBe(join(homedir(), "Documents", "rapor.txt"));
    expect(real.resolve("masaüstü/not.txt")).toBe(join(homedir(), "Desktop", "not.txt"));
    expect(real.resolve("~/Belgeler")).toBe(join(homedir(), "Documents"));
    // And a folder that happens to be called Belgeler somewhere else is not
    // quietly turned into Documents.
    expect(() => real.resolve("/tmp/Belgeler/x.txt")).toThrow(PathRefused);
  });

  // -- reading -----------------------------------------------------------------

  it("lists a folder, and hides dotfiles from the listing too", async () => {
    writeFileSync(join(root, "notlar.txt"), "merhaba");
    writeFileSync(join(root, ".gizli"), "x");
    mkdirSync(join(root, "alt"));
    const out = await call("files_list", { path: root });
    expect(out).toContain("notlar.txt");
    expect(out).toContain("alt/");
    expect(out).not.toContain(".gizli");
  });

  it("lists the newest first, and says when a big folder was cut", async () => {
    for (let i = 0; i < 205; i++) {
      const file = join(root, `f${String(i).padStart(3, "0")}.txt`);
      writeFileSync(file, "x");
      utimesSync(file, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
    }
    const out = await call("files_list", { path: root });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/200 most recently changed of 205/);
    expect(lines[1]).toMatch(/^f204\.txt/);
    expect(out).not.toContain("f004.txt");
  });

  it("says what the open folders are when asked for nothing", async () => {
    expect(await call("files_list", {})).toContain("Belgeler");
  });

  it("marks file contents as untrusted, like a web page", () => {
    expect(tools.get("files_read")!.untrustedOutput).toBe(true);
  });

  it("refuses to pour a binary file into the context", async () => {
    writeFileSync(join(root, "veri.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    expect(await call("files_read", { path: "veri.bin" })).toMatch(/not in a readable format/);
  });

  // -- documents ---------------------------------------------------------------

  it("reads a Word document's text itself, writing nothing beside it", async () => {
    writeFileSync(join(root, "not.txt"), "Seviye süreci yılı artırır.");
    execFileSync("/usr/bin/textutil", ["-convert", "docx", join(root, "not.txt"), "-output", join(root, "Level_Process.docx")]);
    rmSync(join(root, "not.txt"));
    expect(await call("files_read", { path: "Level_Process.docx" })).toContain("Seviye süreci yılı artırır.");
    expect(readdirSync(root)).toEqual(["Level_Process.docx"]);
  });

  it("reads a PDF's text itself", async () => {
    writeFileSync(join(root, "surec.pdf"), minimalPdf("Level Process"));
    expect(await call("files_read", { path: "surec.pdf" })).toContain("Level Process");
    expect(readdirSync(root)).toEqual(["surec.pdf"]);
  });

  it("names the file that is there when the one asked for is not", async () => {
    writeFileSync(join(root, "Level_Process_With_Proposed_Code_Changes.docx"), "x");
    writeFileSync(join(root, "Başka.pdf"), "x");
    await expect(call("files_read", { path: "Level Process With Proposed Code Changes.docx" })).rejects.toThrow(
      /"Level_Process_With_Proposed_Code_Changes.docx"/,
    );
  });

  // -- a file the user attached ----------------------------------------------

  it("reads a file the user attached from outside the open folders, and only that file", async () => {
    const elsewhere = join(home, "Baska");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "ek.txt"), "eklenen");
    writeFileSync(join(elsewhere, "yanindaki.txt"), "açılmadı");
    const roots = new Roots([root]);
    tools = new Map(createFileTools({ roots, shadowDir: join(home, "shadow") }).map((t) => [t.name, t]));

    await expect(call("files_read", { path: join(elsewhere, "ek.txt") })).rejects.toThrow(PathRefused);
    roots.grant(join(elsewhere, "ek.txt"));
    expect(await call("files_read", { path: join(elsewhere, "ek.txt") })).toContain("eklenen");
    await expect(call("files_read", { path: join(elsewhere, "yanindaki.txt") })).rejects.toThrow(PathRefused);
    await expect(call("files_list", { path: elsewhere })).rejects.toThrow(PathRefused);
    await expect(call("files_write", { path: join(elsewhere, "ek.txt"), content: "üzerine" })).rejects.toThrow(PathRefused);
    await expect(call("files_trash", { path: join(elsewhere, "ek.txt") })).rejects.toThrow(PathRefused);
  });

  it("does not list what is beside an attached file that has since gone", async () => {
    const elsewhere = join(home, "Baska");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "ek.txt"), "x");
    writeFileSync(join(elsewhere, "ek_gizli_plan.txt"), "x");
    const roots = new Roots([root]);
    tools = new Map(createFileTools({ roots, shadowDir: join(home, "shadow") }).map((t) => [t.name, t]));
    roots.grant(join(elsewhere, "ek.txt"));
    rmSync(join(elsewhere, "ek.txt"));
    const error = await call("files_read", { path: join(elsewhere, "ek.txt") }).catch((e: Error) => e.message);
    expect(error).not.toContain("ek_gizli_plan");
  });

  it("refuses to attach a folder, a hidden file, or a file inside a hidden folder", () => {
    const roots = new Roots([root]);
    mkdirSync(join(homedir(), ".vunemi-test-hidden"), { recursive: true });
    try {
      writeFileSync(join(homedir(), ".vunemi-test-hidden", "anahtar.txt"), "x");
      writeFileSync(join(root, ".env"), "x");
      expect(() => roots.grant(root)).toThrow(/klasör/);
      expect(() => roots.grant(join(root, ".env"))).toThrow(/gizli/);
      expect(() => roots.grant(join(homedir(), ".vunemi-test-hidden", "anahtar.txt"))).toThrow(/gizli/);
      expect(() => roots.grant(join(root, "yok.txt"))).toThrow(/bulunamadı/);
    } finally {
      rmSync(join(homedir(), ".vunemi-test-hidden"), { recursive: true, force: true });
    }
  });

  it("says when the folder itself is wrong", async () => {
    await expect(call("files_read", { path: "yok/dosya.txt" })).rejects.toThrow(/diye bir klasör yok/);
  });

  // -- writing, and taking it back ---------------------------------------------

  it("keeps the old contents and puts them back on undo", async () => {
    const file = join(root, "notlar.txt");
    writeFileSync(file, "eski hâli");
    await call("files_write", { path: "notlar.txt", content: "yeni hâli" });
    expect(readFileSync(file, "utf8")).toBe("yeni hâli");

    expect(undos).toHaveLength(1);
    await undos[0]!.undo();
    expect(readFileSync(file, "utf8")).toBe("eski hâli");
  });

  it("undoes a brand new file by removing it", async () => {
    await call("files_write", { path: "taze.txt", content: "içerik" });
    expect(undos[0]!.label).toMatch(/silinsin/);
    await undos[0]!.undo();
    expect(existsSync(join(root, "taze.txt"))).toBe(false);
  });

  it("moves a file, and moves it back", async () => {
    writeFileSync(join(root, "a.txt"), "içerik");
    await call("files_move", { from: "a.txt", to: "b.txt" });
    expect(existsSync(join(root, "b.txt"))).toBe(true);
    await undos[0]!.undo();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("içerik");
  });

  it("will not move onto an existing file", async () => {
    writeFileSync(join(root, "a.txt"), "1");
    writeFileSync(join(root, "b.txt"), "2");
    await expect(call("files_move", { from: "a.txt", to: "b.txt" })).rejects.toThrow(/zaten var/);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("2");
  });

  it("classifies the tools so the gate can see them coming", () => {
    expect(tools.get("files_read")!.actionClass).toBe("read");
    expect(tools.get("files_write")!.actionClass).toBe("write-local");
    expect(tools.get("files_trash")!.actionClass).toBe("destructive");
  });

  // -- system_run --------------------------------------------------------------

  it("runs nothing it wasn't told about", async () => {
    await expect(call("system_run", { command: "curl", args: ["https://example.com"] })).rejects.toThrow(/curl/);
    await expect(call("system_run", { command: "sh", args: ["-c", "ls"] })).rejects.toThrow(/çalıştırılamaz/);
  });

  it("refuses arguments that are really shell", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    for (const arg of ["a.txt; rm -rf ~", "a.txt | tee /tmp/x", "`whoami`", "$(id)", "a.txt > /tmp/out"]) {
      await expect(call("system_run", { command: "textutil", args: ["-convert", "rtf", arg] })).rejects.toThrow(
        PathRefused,
      );
    }
  });

  it("refuses to touch files outside the open folders even with an allowed program", async () => {
    await expect(
      call("system_run", { command: "textutil", args: ["-convert", "txt", "/etc/hosts"] }),
    ).rejects.toThrow(/dışında/);
  });

  it("converts a file, and offers to undo what it made", async () => {
    writeFileSync(join(root, "not.txt"), "merhaba dünya");
    await call("system_run", { command: "textutil", args: ["-convert", "rtf", join(root, "not.txt")] });
    const made = join(root, "not.rtf");
    expect(existsSync(made)).toBe(true);

    expect(undos).toHaveLength(1);
    await undos[0]!.undo();
    expect(existsSync(made)).toBe(false);
    // The original is untouched either way.
    expect(readFileSync(join(root, "not.txt"), "utf8")).toBe("merhaba dünya");
  });

  it("keeps a copy of an output it overwrites, says so, and can put it back", async () => {
    writeFileSync(join(root, "not.txt"), "yeni metin");
    writeFileSync(join(root, "not.rtf"), "ESKİ RTF");
    const out = await call("system_run", { command: "textutil", args: ["-convert", "rtf", join(root, "not.txt")] });
    expect(out).toMatch(/overwrote existing file\(s\): .*not\.rtf/);
    expect(readFileSync(join(root, "not.rtf"), "utf8")).not.toBe("ESKİ RTF");
    expect(undos).toHaveLength(1);
    // Live, 27 Sep: the button said "Delete not.rtf" while it put the old one back.
    expect(undos[0]!.label).toBe(t("files.undo.restore", { name: "not.rtf" }));
    await undos[0]!.undo();
    expect(readFileSync(join(root, "not.rtf"), "utf8")).toBe("ESKİ RTF");
    expect(readFileSync(join(root, "not.txt"), "utf8")).toBe("yeni metin");
  });

  // -- looking before writing --------------------------------------------------

  it("won't write plain text over a document or a binary file", async () => {
    writeFileSync(join(root, "rapor.docx"), "PK\u0003\u0004");
    await expect(call("files_write", { path: join(root, "rapor.docx"), content: "x" })).rejects.toThrow(PathRefused);
    writeFileSync(join(root, "veri.bin"), Buffer.from([1, 0, 2, 3]));
    await expect(call("files_write", { path: join(root, "veri.bin"), content: "x" })).rejects.toThrow(PathRefused);
    expect(readFileSync(join(root, "veri.bin"))).toEqual(Buffer.from([1, 0, 2, 3]));
  });

  it("says on the card when a write replaces a file", async () => {
    writeFileSync(join(root, "var.txt"), "eski");
    const write = tools.get("files_write")!;
    const replacing = await write.preview!({ path: join(root, "var.txt"), content: "a\nb" } as never);
    const fresh = await write.preview!({ path: join(root, "yok.txt"), content: "a\nb" } as never);
    expect(replacing).not.toBe(fresh);
    expect(replacing).toContain("4 B");
  });

  it("refuses a move into a folder that isn't there, plainly", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    await expect(call("files_move", { from: join(root, "a.txt"), to: join(root, "yok", "a.txt") })).rejects.toThrow(PathRefused);
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });

  // -- what it leaves behind ---------------------------------------------------

  // Reported as the real path: tmpdir sits behind a symlink on macOS.
  const real = (name: string) => join(realpathSync(root), name);

  it("announces the file it wrote, so the user can find it again", async () => {
    await call("files_write", { path: join(root, "rapor.md"), content: "# Rapor" });
    expect(made).toEqual([{ kind: "file", path: real("rapor.md") }]);
  });

  it("announces where a moved file ended up, not where it was", async () => {
    writeFileSync(join(root, "eski.md"), "x");
    await call("files_move", { from: join(root, "eski.md"), to: join(root, "yeni.md") });
    expect(made).toEqual([{ kind: "file", path: real("yeni.md") }]);
  });

  it("announces what a converter created", async () => {
    writeFileSync(join(root, "not.txt"), "merhaba dünya");
    await call("system_run", { command: "textutil", args: ["-convert", "rtf", join(root, "not.txt")] });
    expect(made).toEqual([{ kind: "file", path: real("not.rtf") }]);
  });

  it("does not present a file sent to the Trash as something it made", async () => {
    writeFileSync(join(root, "gereksiz.md"), "x");
    await call("files_trash", { path: join(root, "gereksiz.md") });
    expect(made).toEqual([]);
  });
});

describe("spotlightQuery", () => {
  it("reads *.pdf as a kind of file, and a bare pdf as either", () => {
    expect(spotlightQuery("*.pdf")).toBe('kMDItemFSName == "*.pdf"c');
    expect(spotlightQuery(".PDF")).toBe('kMDItemFSName == "*.PDF"c');
    expect(spotlightQuery("pdf")).toContain('kMDItemFSName == "*.pdf"c');
    expect(spotlightQuery("fatura 7429")).not.toContain("kMDItemFSName");
    // Still one quoted value: nothing a query says can add a clause.
    expect(spotlightQuery('x" || kMDItemFSName == "*')).not.toMatch(/[^\\]" \|\| kMDItemFSName == "\*"/);
  });
});

describe("similarNames", () => {
  const names = ["Level_Process_With_Proposed_Code_Changes.docx", "Level Process.pdf", "DQSG_Year_Fields.docx"];

  it("puts a name differing only in spaces, underscores or case first", () => {
    expect(similarNames("level process with proposed code changes.docx", names)).toEqual(["Level_Process_With_Proposed_Code_Changes.docx"]);
  });

  it("falls back to names sharing most of the words", () => {
    expect(similarNames("Level Process Changes.docx", names)[0]).toBe("Level_Process_With_Proposed_Code_Changes.docx");
  });

  it("offers nothing rather than something unrelated", () => {
    expect(similarNames("fatura.pdf", names)).toEqual([]);
  });
});

describe("files_search", () => {
  it("asks Spotlight with fixed arguments and shows only what is inside the open folders", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-search-")));
    const root = join(home, "Belgeler");
    mkdirSync(root);
    const inside = join(root, "fatura.pdf");
    writeFileSync(inside, "x");
    const log = join(home, "args.json");
    const fake = join(home, "mdfind");
    writeFileSync(fake, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
console.log([${JSON.stringify(inside)}, "/etc/passwd", ${JSON.stringify(join(root, ".gizli"))}, ${JSON.stringify(join(root, "X.app/Contents/a"))}].join("\\n"));
`, { mode: 0o755 });
    const search = createFileTools({ roots: new Roots([root]), shadowDir: join(home, "shadow"), mdfind: fake }).find((t) => t.name === "files_search")!;
    const out = await search.run({ query: 'fatura "7*' }, { signal: new AbortController().signal } as ToolContext);
    expect(out).toContain("fatura.pdf");
    expect(out).not.toMatch(/passwd|gizli|X\.app/);
    const args = JSON.parse(readFileSync(log, "utf8")) as string[];
    expect(args.slice(0, 2)).toEqual(["-onlyin", root]);
    expect(args[2]).toBe('(kMDItemTextContent == "*fatura \\"7\\**"cd || kMDItemDisplayName == "*fatura \\"7\\**"cd)');
    rmSync(home, { recursive: true, force: true });
  });
  it("puts the newest first, with its day", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-search-")));
    const root = join(home, "Belgeler");
    mkdirSync(root);
    const old = join(root, "eski.pdf");
    const fresh = join(root, "yeni.pdf");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    utimesSync(old, new Date("2024-01-02"), new Date("2024-01-02"));
    utimesSync(fresh, new Date("2026-09-20"), new Date("2026-09-20"));
    const fake = join(home, "mdfind");
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log([${JSON.stringify(old)}, ${JSON.stringify(fresh)}].join("\\n"));\n`, { mode: 0o755 });
    const search = createFileTools({ roots: new Roots([root]), shadowDir: join(home, "shadow"), mdfind: fake }).find((t) => t.name === "files_search")!;
    const out = await search.run({ query: "*.pdf" }, { signal: new AbortController().signal } as ToolContext);
    expect(out.indexOf("yeni.pdf (2026-09-20)")).toBeGreaterThan(-1);
    expect(out.indexOf("yeni.pdf")).toBeLessThan(out.indexOf("eski.pdf (2024-01-02)"));
    rmSync(home, { recursive: true, force: true });
  });
});
