import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_WALK, walkMatcher, walkSearch } from "../src/search-walk.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "walk-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const limits = (more: Partial<typeof DEFAULT_WALK> = {}) => ({ ...DEFAULT_WALK, ...more, deadline: Date.now() + 5_000 });

it("reads *.ext as a kind of file and other words as name or text", () => {
  expect(walkMatcher("*.PDF").name("a.pdf")).toBe(true);
  expect(walkMatcher(".pdf").text).toBeNull();
  const words = walkMatcher("Fatura 7429");
  expect(words.name("eski fatura 7429.txt")).toBe(true);
  expect(words.text!("... FATURA 7429 ...")).toBe(true);
});

it("does not follow symbolic links out of the folder", async () => {
  const outside = mkdtempSync(join(tmpdir(), "walk-out-"));
  try {
    writeFileSync(join(outside, "secret-match.txt"), "x");
    symlinkSync(outside, join(dir, "link"));
    expect((await walkSearch([dir], "secret", limits())).found).toEqual([]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

it("stops at its limits and says it was cut", async () => {
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `match-${i}.txt`), "x");
  const few = await walkSearch([dir], "match", limits({ maxFound: 5 }));
  expect(few.found).toHaveLength(5);
  expect(few.cut).toBe(true);
  mkdirSync(join(dir, "deep"));
  expect((await walkSearch([dir], "nothing", limits({ maxEntries: 3 }))).cut).toBe(true);
});

it("does not read large or binary files for words", async () => {
  writeFileSync(join(dir, "big.txt"), `needle${" ".repeat(2048)}`);
  writeFileSync(join(dir, "bin.txt"), Buffer.from([0, 1, 2, ...Buffer.from("needle")]));
  expect((await walkSearch([dir], "needle", limits({ maxTextBytes: 1024 }))).found).toEqual([]);
});

it("stops when the run is stopped", async () => {
  const stop = new AbortController();
  stop.abort(new Error("stopped"));
  await expect(walkSearch([dir], "x", { ...limits(), signal: stop.signal })).rejects.toThrow(/stopped/);
});

it("lets other work through while it walks, so a stop pressed meanwhile reaches it", async () => {
  // Enough text files that the walk outlasts the timer below.
  const body = "y".repeat(200_000);
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `note-${i}.txt`), body);
  const stop = new AbortController();
  let fired = false;
  setTimeout(() => {
    fired = true;
    stop.abort(new Error("stopped"));
  }, 20);
  await expect(walkSearch([dir], "needle", { ...limits(), signal: stop.signal })).rejects.toThrow(/stopped/);
  expect(fired).toBe(true);
});

it("reads the words inside a small text file", async () => {
  writeFileSync(join(dir, "notes.md"), "The invoice number is 7429.");
  writeFileSync(join(dir, "empty.txt"), "");
  expect((await walkSearch([dir], "invoice number", limits())).found).toEqual([join(dir, "notes.md")]);
});
