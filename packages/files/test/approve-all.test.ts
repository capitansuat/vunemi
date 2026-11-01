import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { approveAllCover, LOCAL_WORK } from "@vunemi/agent-core";
import { createFileTools, Roots } from "../src/index.js";

let home = "";
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "approve-all-"))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const tool = (name: string) => {
  const found = createFileTools({ moveAdmission: async (_path: string, body: (release: () => void) => unknown) => body(() => {}), roots: new Roots([home]), shadowDir: join(home, "shadow") } as never).find((t) => t.name === name);
  if (!found) throw new Error(`No ${name}.`);
  return found;
};

it("covers a new file but keeps a card for replacing one", async () => {
  writeFileSync(join(home, "old.txt"), "keep");
  expect(await approveAllCover(tool("files_write"), { path: join(home, "new.txt"), content: "x" })).toEqual({ key: LOCAL_WORK });
  expect(await approveAllCover(tool("files_write"), { path: join(home, "old.txt"), content: "x" })).toBeUndefined();
});

it("covers nothing outside the open folders", async () => {
  expect(await approveAllCover(tool("files_write"), { path: "/etc/vunemi-new.txt", content: "x" })).toBeUndefined();
});

it("never reaches moving or trashing", async () => {
  expect(await approveAllCover(tool("files_trash"), { path: join(home, "old.txt") })).toBeUndefined();
  expect(await approveAllCover(tool("files_move"), { path: join(home, "old.txt") })).toBeUndefined();
});
