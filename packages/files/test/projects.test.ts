/**
 * Project folders and the tools that build things in them: a website's
 * folders made on the way, a small change to a long file, and every one of
 * them undoable.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolDef } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileTools, PathRefused, projectFolderProblem, Roots } from "../src/index.js";

let home = "";
let docs = "";
let project = "";
let roots: Roots;
let tools: Map<string, ToolDef>;
let undos: { label: string; undo: () => Promise<void> }[];

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: (label, undo) => undos.push({ label, undo }),
  attach: () => {},
});
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args as never, ctx());

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-projects-")));
  docs = join(home, "Documents");
  project = join(home, "Work", "site");
  mkdirSync(docs, { recursive: true });
  mkdirSync(project, { recursive: true });
  roots = new Roots([docs]);
  undos = [];
  tools = new Map(createFileTools({ roots, shadowDir: join(home, "shadow") }).map((t) => [t.name, t]));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("project folders", () => {
  it("are closed until the user makes one a project", async () => {
    writeFileSync(join(project, "index.html"), "<h1>Hi</h1>");
    await expect(call("files_read", { path: join(project, "index.html") })).rejects.toThrow(PathRefused);
    roots.setProjects([project], null);
    expect(await call("files_read", { path: join(project, "index.html") })).toBe("<h1>Hi</h1>");
  });

  it("put the current project first, so a bare name is a file in it", async () => {
    roots.setProjects([project], project);
    expect(roots.list()[0]).toBe(project);
    await call("files_write", { path: "notes.md", content: "# Notes" });
    expect(readFileSync(join(project, "notes.md"), "utf8")).toBe("# Notes");
    // Leaving the project: a bare name goes back to the first ordinary folder.
    roots.setProjects([project], null);
    await call("files_write", { path: "notes.md", content: "elsewhere" });
    expect(readFileSync(join(docs, "notes.md"), "utf8")).toBe("elsewhere");
  });

  it("still hide what is hidden inside a project", async () => {
    writeFileSync(join(project, ".env"), "TOKEN=abc");
    roots.setProjects([project], project);
    await expect(call("files_read", { path: ".env" })).rejects.toThrow(PathRefused);
  });

  it("are the user's own work, not their whole home, Library or a hidden folder", () => {
    mkdirSync(join(home, "Library", "Application Support", "x"), { recursive: true });
    mkdirSync(join(home, ".config", "x"), { recursive: true });
    expect(projectFolderProblem(project, home)).toBeNull();
    expect(projectFolderProblem(home, home)).toBeTruthy();
    expect(projectFolderProblem(join(home, "Library", "Application Support", "x"), home)).toBeTruthy();
    expect(projectFolderProblem(join(home, ".config", "x"), home)).toBeTruthy();
    expect(projectFolderProblem(tmpdir(), home)).toBeTruthy();
    expect(projectFolderProblem(join(home, "nowhere"), home)).toBeTruthy();
    // Vunemi's own data folder, or one holding it.
    expect(projectFolderProblem(project, home, [join(project, "data")])).toBeTruthy();
  });

  it("can't be smuggled in through a link to a forbidden place", () => {
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    symlinkSync(join(home, "Library", "Keychains"), join(home, "Work", "keys"));
    expect(projectFolderProblem(join(home, "Work", "keys"), home)).toBeTruthy();
  });
});

describe("files_write in a project", () => {
  beforeEach(() => roots.setProjects([project], project));

  it("makes the folders a new file needs, and undo takes them away again", async () => {
    await call("files_write", { path: "css/theme/main.css", content: "body{}" });
    expect(readFileSync(join(project, "css", "theme", "main.css"), "utf8")).toBe("body{}");
    await undos[0]!.undo();
    expect(existsSync(join(project, "css"))).toBe(false);
  });

  it("leaves a folder it made alone if the user has put something in it since", async () => {
    await call("files_write", { path: "img/logo.svg", content: "<svg/>" });
    writeFileSync(join(project, "img", "photo.txt"), "mine");
    await undos[0]!.undo();
    expect(existsSync(join(project, "img", "logo.svg"))).toBe(false);
    expect(readFileSync(join(project, "img", "photo.txt"), "utf8")).toBe("mine");
  });

  it("won't make a deep tree in one go", async () => {
    await expect(call("files_write", { path: "a/b/c/d/e.txt", content: "x" })).rejects.toThrow(PathRefused);
    expect(existsSync(join(project, "a"))).toBe(false);
  });
});

describe("files_edit", () => {
  beforeEach(() => roots.setProjects([project], project));

  it("changes one exact piece and keeps the rest", async () => {
    writeFileSync(join(project, "index.html"), "<title>Old</title>\n<h1>Welcome</h1>\n<p>Text</p>\n");
    const out = await call("files_edit", { path: "index.html", old_text: "<h1>Welcome</h1>", new_text: "<h1>Hoş geldin</h1>" });
    expect(out).toMatch(/^Changed /);
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe("<title>Old</title>\n<h1>Hoş geldin</h1>\n<p>Text</p>\n");
    await undos[0]!.undo();
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe("<title>Old</title>\n<h1>Welcome</h1>\n<p>Text</p>\n");
  });

  it("refuses text that isn't there, or is there more than once, and changes nothing", async () => {
    writeFileSync(join(project, "a.txt"), "x\nx\n");
    await expect(call("files_edit", { path: "a.txt", old_text: "y", new_text: "z" })).rejects.toThrow(PathRefused);
    await expect(call("files_edit", { path: "a.txt", old_text: "x", new_text: "z" })).rejects.toThrow(/2/);
    await expect(call("files_edit", { path: "a.txt", old_text: "", new_text: "z" })).rejects.toThrow(PathRefused);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("x\nx\n");
    expect(undos).toHaveLength(0);
  });

  it("takes the new text literally, $ signs and all", async () => {
    writeFileSync(join(project, "price.txt"), "price: TBD\n");
    await call("files_edit", { path: "price.txt", old_text: "TBD", new_text: "$& $1 $$" });
    expect(readFileSync(join(project, "price.txt"), "utf8")).toBe("price: $& $1 $$\n");
  });

  it("won't write text into a document it can't read as text", async () => {
    writeFileSync(join(project, "report.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
    await expect(call("files_edit", { path: "report.docx", old_text: "PK", new_text: "x" })).rejects.toThrow(PathRefused);
  });

  it("is a local write, like files_write", () => {
    expect(tools.get("files_edit")!.actionClass).toBe("write-local");
  });
});
