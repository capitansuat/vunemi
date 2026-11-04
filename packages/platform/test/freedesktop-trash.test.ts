import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHomeOf, deletionDate, encodeTrashPath, freedesktopMoveToTrash, mountTopOf, TrashRefused } from "../src/index.js";

let root: string;
let dataHome: string;
let docs: string;
const at = new Date(2026, 0, 2, 3, 4, 5);
const opts = () => ({ dataHome, now: () => at });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vunemi-trash-"));
  dataHome = join(root, "share");
  docs = join(root, "Documents");
  mkdirSync(docs);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("freedesktop Trash", () => {
  it("moves a file to the home Trash with an info file saying where it was and when", () => {
    const file = join(docs, "report.txt");
    writeFileSync(file, "synthetic");
    const trashed = freedesktopMoveToTrash(file, opts());
    expect(existsSync(file)).toBe(false);
    expect(trashed.path).toBe(join(dataHome, "Trash", "files", "report.txt"));
    expect(readFileSync(trashed.path, "utf8")).toBe("synthetic");
    const info = readFileSync(join(dataHome, "Trash", "info", "report.txt.trashinfo"), "utf8");
    expect(info).toBe(`[Trash Info]\nPath=${encodeTrashPath(file)}\nDeletionDate=2026-01-02T03:04:05\n`);
  });

  it("puts it back on undo and drops the info file, but never over a new file", () => {
    const file = join(docs, "a.txt");
    writeFileSync(file, "one");
    const first = freedesktopMoveToTrash(file, opts());
    first.restore();
    expect(readFileSync(file, "utf8")).toBe("one");
    expect(readdirSync(join(dataHome, "Trash", "info"))).toEqual([]);

    const again = freedesktopMoveToTrash(file, opts());
    writeFileSync(file, "new one");
    again.restore();
    // The new file stays; the trashed one stays in the Trash.
    expect(readFileSync(file, "utf8")).toBe("new one");
    expect(readFileSync(again.path, "utf8")).toBe("one");
  });

  it("gives a second file of the same name its own slot", () => {
    for (const body of ["first", "second"]) {
      writeFileSync(join(docs, "same.txt"), body);
      freedesktopMoveToTrash(join(docs, "same.txt"), opts());
    }
    const files = readdirSync(join(dataHome, "Trash", "files")).sort();
    expect(files).toEqual(["same 2.txt", "same.txt"]);
    expect(readdirSync(join(dataHome, "Trash", "info")).sort()).toEqual(["same 2.txt.trashinfo", "same.txt.trashinfo"]);
    expect(readFileSync(join(dataHome, "Trash", "files", "same 2.txt"), "utf8")).toBe("second");
  });

  it("does not take a name whose info file someone else already reserved", () => {
    mkdirSync(join(dataHome, "Trash", "info"), { recursive: true });
    writeFileSync(join(dataHome, "Trash", "info", "x.txt.trashinfo"), "[Trash Info]\n");
    writeFileSync(join(docs, "x.txt"), "mine");
    const trashed = freedesktopMoveToTrash(join(docs, "x.txt"), opts());
    expect(trashed.path).toBe(join(dataHome, "Trash", "files", "x 2.txt"));
  });

  it("trashes folders whole", () => {
    const folder = join(docs, "Project");
    mkdirSync(join(folder, "sub"), { recursive: true });
    writeFileSync(join(folder, "sub", "f.txt"), "x");
    const trashed = freedesktopMoveToTrash(folder, opts());
    expect(readFileSync(join(trashed.path, "sub", "f.txt"), "utf8")).toBe("x");
  });

  it("refuses a missing file and the Trash itself, and deletes nothing", () => {
    expect(() => freedesktopMoveToTrash(join(docs, "nope.txt"), opts())).toThrow(TrashRefused);
    writeFileSync(join(docs, "k.txt"), "keep");
    const trashed = freedesktopMoveToTrash(join(docs, "k.txt"), opts());
    expect(() => freedesktopMoveToTrash(trashed.path, opts())).toThrow(/already in the Trash/);
    expect(() => freedesktopMoveToTrash(join(dataHome, "Trash"), opts())).toThrow(/already in the Trash/);
    expect(readFileSync(trashed.path, "utf8")).toBe("keep");
  });

  it("trashes a symbolic link, not what it points to", () => {
    writeFileSync(join(docs, "target.txt"), "target");
    symlinkSync(join(docs, "target.txt"), join(docs, "link.txt"));
    freedesktopMoveToTrash(join(docs, "link.txt"), opts());
    expect(readFileSync(join(docs, "target.txt"), "utf8")).toBe("target");
    expect(existsSync(join(docs, "link.txt"))).toBe(false);
  });

  it("encodes the recorded path so it cannot break the info file", () => {
    expect(encodeTrashPath("/home/u/a b/ç\nx.txt")).toBe("/home/u/a%20b/%C3%A7%0Ax.txt");
    const file = join(docs, "line\nbreak.txt");
    writeFileSync(file, "x");
    freedesktopMoveToTrash(file, opts());
    const info = readFileSync(join(dataHome, "Trash", "info", "line\nbreak.txt.trashinfo"), "utf8");
    expect(info.split("\n")).toHaveLength(4);
  });

  it("reads XDG_DATA_HOME as the spec does", () => {
    expect(dataHomeOf({ XDG_DATA_HOME: "/x/data" }, "/home/u")).toBe("/x/data");
    expect(dataHomeOf({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/share");
    expect(dataHomeOf({}, "/home/u")).toBe("/home/u/.local/share");
  });

  it("writes the local time without a zone", () => {
    expect(deletionDate(new Date(2026, 10, 4, 9, 8, 7))).toBe("2026-11-04T09:08:07");
  });

  it("finds the top of a file system", () => {
    expect(statSync(mountTopOf(docs)).dev).toBe(statSync(docs).dev);
  });

  // A second file system: /dev/shm is a tmpfs on most Linux systems.
  const shm = "/dev/shm";
  const otherFs = process.platform === "linux" && existsSync(shm) && (() => {
    try {
      return statSync(shm).dev !== statSync(tmpdir()).dev;
    } catch {
      return false;
    }
  })();
  it.skipIf(!otherFs)("uses $topdir/.Trash-$uid for a file on another file system, never copying it", () => {
    const top = mountTopOf(shm);
    const uid = process.getuid!();
    const own = join(top, `.Trash-${uid}`);
    const existed = existsSync(own);
    const file = join(shm, `vunemi-trash-test-${process.pid}.txt`);
    writeFileSync(file, "elsewhere");
    try {
      const trashed = freedesktopMoveToTrash(file, opts());
      expect(trashed.path.startsWith(join(own, "files"))).toBe(true);
      expect(statSync(own).mode & 0o777).toBe(0o700);
      const name = trashed.path.slice(join(own, "files").length + 1);
      const info = readFileSync(join(own, "info", `${name}.trashinfo`), "utf8");
      // Relative to the top of that file system, as the spec allows there.
      expect(info).toContain(`Path=${encodeTrashPath(file.slice(top.length + (top.endsWith("/") ? 0 : 1)))}\n`);
      trashed.restore();
      expect(readFileSync(file, "utf8")).toBe("elsewhere");
    } finally {
      rmSync(file, { force: true });
      if (!existed) rmSync(own, { recursive: true, force: true });
    }
  });
});
