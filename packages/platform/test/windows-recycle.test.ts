/**
 * The Windows Recycle Bin, done by rename into the bin folder Explorer reads.
 * Every system runs the format and the moves against a stand-in bin folder;
 * the real bin is used on Windows only, with a synthetic temp file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { readRecycleInfo, recycleInfo, RecycleRefused, windowsMoveToTrash } from "../src/windows-recycle.js";
const onWindows = process.platform === "win32";

let root: string;
let bin: string;
let docs: string;
const at = new Date(Date.UTC(2026, 10, 23, 9, 30, 0));
const opts = () => ({ binFor: () => bin, now: () => at });

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "vunemi-recycle-")));
  bin = join(root, "bin");
  docs = join(root, "Documents");
  mkdirSync(bin);
  mkdirSync(docs);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof RecycleRefused) return err.code;
    throw err;
  }
  return undefined;
}

describe("the $I record", () => {
  it("says where the file was, how big it was and when it was deleted", () => {
    const info = recycleInfo("C:\\Users\\deneme\\Documents\\rapor.txt", 1234n, at);
    // Version 2, as Windows 10 and 11 write it.
    expect(info.readBigInt64LE(0)).toBe(2n);
    expect(readRecycleInfo(info)).toEqual({ path: "C:\\Users\\deneme\\Documents\\rapor.txt", size: 1234n, deletedAt: at });
  });
});

describe("moving to the Recycle Bin", () => {
  it("renames the file into the bin as $R…, with its $I record, same bytes", () => {
    const file = join(docs, "rapor.txt");
    writeFileSync(file, "synthetic report");
    const trashed = windowsMoveToTrash(file, opts());
    expect(existsSync(file)).toBe(false);
    expect(parse(trashed.path).dir).toBe(bin);
    expect(parse(trashed.path).base).toMatch(/^\$R[A-Z0-9]{6}\.txt$/);
    expect(readFileSync(trashed.path, "utf8")).toBe("synthetic report");
    const record = join(bin, parse(trashed.path).base.replace(/^\$R/, "$I"));
    expect(readRecycleInfo(readFileSync(record))).toEqual({ path: file, size: 16n, deletedAt: at });
  });

  it("puts it back on undo and leaves nothing in the bin", () => {
    const file = join(docs, "a.txt");
    writeFileSync(file, "one");
    windowsMoveToTrash(file, opts()).restore();
    expect(readFileSync(file, "utf8")).toBe("one");
    expect(readdirSync(bin)).toEqual([]);
  });

  it("never restores over a file that took its place; both stay", () => {
    const file = join(docs, "a.txt");
    writeFileSync(file, "old");
    const trashed = windowsMoveToTrash(file, opts());
    writeFileSync(file, "new");
    expect(refusal(() => trashed.restore())).toBe("taken");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(readFileSync(trashed.path, "utf8")).toBe("old");
  });

  it("gives two files of the same name their own slots, and each goes home", () => {
    const other = join(root, "Desktop");
    mkdirSync(other);
    writeFileSync(join(docs, "a.txt"), "docs");
    writeFileSync(join(other, "a.txt"), "desktop");
    const one = windowsMoveToTrash(join(docs, "a.txt"), opts());
    const two = windowsMoveToTrash(join(other, "a.txt"), opts());
    expect(one.path).not.toBe(two.path);
    two.restore();
    one.restore();
    expect(readFileSync(join(docs, "a.txt"), "utf8")).toBe("docs");
    expect(readFileSync(join(other, "a.txt"), "utf8")).toBe("desktop");
    expect(readdirSync(bin)).toEqual([]);
  });

  it("moves a folder whole and puts it back", () => {
    const folder = join(docs, "Proje");
    mkdirSync(folder);
    writeFileSync(join(folder, "x.txt"), "12345");
    const trashed = windowsMoveToTrash(folder, opts());
    expect(existsSync(folder)).toBe(false);
    expect(readRecycleInfo(readFileSync(join(bin, parse(trashed.path).base.replace(/^\$R/, "$I")))).size).toBe(5n);
    trashed.restore();
    expect(readFileSync(join(folder, "x.txt"), "utf8")).toBe("12345");
    expect(readdirSync(bin)).toEqual([]);
  });

  it("refuses when there is no bin folder, and the file stays", () => {
    const file = join(docs, "a.txt");
    writeFileSync(file, "stays");
    rmSync(bin, { recursive: true });
    expect(refusal(() => windowsMoveToTrash(file, opts()))).toBe("no-bin");
    expect(readFileSync(file, "utf8")).toBe("stays");
    expect(existsSync(bin)).toBe(false);
  });

  it("refuses a missing file and anything already in the bin", () => {
    expect(refusal(() => windowsMoveToTrash(join(docs, "yok.txt"), opts()))).toBe("missing");
    writeFileSync(join(bin, "$RABCDEF.txt"), "x");
    expect(refusal(() => windowsMoveToTrash(join(bin, "$RABCDEF.txt"), opts()))).toBe("is-bin");
    expect(refusal(() => windowsMoveToTrash(bin, opts()))).toBe("is-bin");
  });
});

describe.runIf(onWindows)("the real Recycle Bin", () => {
  it("takes a temp file, records its path, and gives it back", () => {
    const file = join(docs, "vunemi-recycle-deneme.txt");
    writeFileSync(file, "synthetic");
    const trashed = windowsMoveToTrash(file);
    expect(existsSync(file)).toBe(false);
    expect(parse(trashed.path).dir.toLowerCase()).toContain("\\$recycle.bin\\s-1-");
    const record = join(parse(trashed.path).dir, parse(trashed.path).base.replace(/^\$R/, "$I"));
    expect(readRecycleInfo(readFileSync(record)).path).toBe(file);
    // VUNEMI_RECYCLE_KEEP=1 leaves it in the bin, to be seen and restored in Explorer.
    if (process.env.VUNEMI_RECYCLE_KEEP === "1") return;
    trashed.restore();
    expect(readFileSync(file, "utf8")).toBe("synthetic");
    expect(existsSync(trashed.path) || existsSync(record)).toBe(false);
  });
});
