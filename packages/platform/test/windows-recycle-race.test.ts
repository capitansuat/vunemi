/**
 * Restoring a folder from the Recycle Bin while a file appears at its old
 * place. Windows' rename replaces a file with a folder (seen in the VM, 23 Nov),
 * so the restore must claim the place first and refuse when something is there.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const race = vi.hoisted(() => ({ at: "" as string }));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    // Right after the check says the place is free, a file takes it.
    existsSync: (path: import("node:fs").PathLike) => {
      const free = actual.existsSync(path);
      if (race.at && String(path) === race.at) {
        race.at = "";
        actual.writeFileSync(String(path), "appeared meanwhile");
      }
      return free;
    },
  };
});
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecycleRefused, windowsMoveToTrash } from "../src/windows-recycle.js";

let root = "";
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "vunemi-recycle-race-"))); mkdirSync(join(root, "bin")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("never puts a folder back over a file that appeared during the restore", () => {
  const folder = join(root, "Proje");
  mkdirSync(folder);
  writeFileSync(join(folder, "x.txt"), "inside");
  const trashed = windowsMoveToTrash(folder, { binFor: () => join(root, "bin") });
  race.at = folder;
  let code: string | undefined;
  try {
    trashed.restore();
  } catch (err) {
    code = err instanceof RecycleRefused ? err.code : String(err);
  }
  expect(code).toBe("taken");
  expect(readFileSync(folder, "utf8")).toBe("appeared meanwhile");
  expect(readFileSync(join(trashed.path, "x.txt"), "utf8")).toBe("inside");
});
