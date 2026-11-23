import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncFolder } from "../src/index.js";

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, fsyncSync: vi.fn(real.fsyncSync) };
});

describe("syncFolder", () => {
  afterEach(() => vi.mocked(fs.fsyncSync).mockClear());

  it("fsyncs the folder itself on macOS and Linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-sync-"));
    syncFolder(dir, "darwin");
    syncFolder(dir, "linux");
    expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("does not open the folder on Windows, which refuses to fsync one", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-sync-"));
    syncFolder(dir, "win32");
    expect(fs.fsyncSync).not.toHaveBeenCalled();
  });

  it("fails when the folder is gone, on every system", () => {
    const gone = join(tmpdir(), `vunemi-sync-gone-${Date.now()}`);
    for (const system of ["darwin", "linux", "win32"] as const) expect(() => syncFolder(gone, system)).toThrow();
  });

  it("fails on Windows when the path is a file, not a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-sync-"));
    const file = join(dir, "f");
    writeFileSync(file, "x");
    expect(() => syncFolder(file, "win32")).toThrow();
  });
});
