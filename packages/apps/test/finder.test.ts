import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@vunemi/agent-core";
import { Roots } from "@vunemi/files";
import { createFinderTools, FINDER_REVEAL, FINDER_SELECTION } from "../src/finder.js";

const ctx = {} as ToolContext;
let dir: string;
let roots: Roots;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-finder-"));
  mkdirSync(join(dir, "open"));
  writeFileSync(join(dir, "open", "report.pdf"), "x");
  roots = new Roots([join(dir, "open")]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tool = (run: Parameters<typeof createFinderTools>[0], name: string) => createFinderTools(run, roots).find((t) => t.name === name)!;

describe("Finder tools", () => {
  it("lists the selection, and only what is inside the open folders", async () => {
    const inside = join(roots.list()[0]!, "report.pdf");
    const run = vi.fn(async () => [inside, "/etc/passwd"]);
    const out = await tool(run, "finder_selection").run({}, ctx);
    expect(run).toHaveBeenCalledWith(FINDER_SELECTION, { app: "Finder" });
    expect(out).toContain("report.pdf");
    expect(out).not.toContain("/etc/passwd");
    expect(out).toMatch(/1 item .*outside/);
  });

  it("says when nothing is selected", async () => {
    expect(await tool(async () => [], "finder_selection").run({}, ctx)).toMatch(/Nothing is selected/);
  });

  it("reveals a file inside an open folder", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    await tool(run, "finder_reveal").run({ path: join(roots.list()[0]!, "report.pdf") }, ctx);
    expect(run).toHaveBeenCalledWith(FINDER_REVEAL, { app: "Finder", path: join(roots.list()[0]!, "report.pdf") });
  });

  it("refuses to reveal anything outside the open folders", async () => {
    const run = vi.fn();
    await expect(tool(run, "finder_reveal").run({ path: "/etc/passwd" }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("marks both as reads", () => {
    const tools = createFinderTools(async () => null, roots);
    expect(tools.map((t) => [t.name, t.actionClass])).toEqual([["finder_selection", "read"], ["finder_reveal", "read"]]);
    expect(tools[0]!.untrustedOutput).toBe(true);
  });
});
