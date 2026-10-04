import { describe, expect, it } from "vitest";
import { KeptOutputs, keptOutputTools, keptNote, readPart, searchLines } from "../src/kept.js";

const page = Array.from({ length: 40 }, (_, i) => `Room ${i + 1}: booking code ${1000 + i}.`).join("\n");

describe("KeptOutputs", () => {
  it("shows the first part and says how to read the rest", () => {
    const kept = new KeptOutputs();
    const shown = kept.keep("page_read", page, 300);
    expect(shown.startsWith(page.slice(0, 300))).toBe(true);
    expect(shown).toContain(`of ${page.length.toLocaleString("en-GB")}`);
    expect(shown).toContain('kept as "o1": output_read with id "o1" and part 2–4');
  });

  it("reads every part in order, and the parts make the whole", () => {
    const kept = new KeptOutputs();
    kept.keep("page_read", page, 300);
    const body = (s: string) => s.replace(/\n\[Part \d+ of \d+[^\]]*\]$/, "");
    const whole = page.slice(0, 300) + [2, 3, 4].map((n) => body(kept.read("o1", n))).join("");
    expect(whole).toBe(page);
    expect(kept.read("o1", 2)).toMatch(/\[Part 2 of 4\. output_read part 3 continues\.\]$/);
    expect(kept.read("o1", 4)).toMatch(/\[Part 4 of 4, the last\.\]$/);
    expect(() => kept.read("o1", 5)).toThrow(/parts 1–4/);
  });

  it("finds lines with all the words, saying which part they are in", () => {
    const kept = new KeptOutputs();
    kept.keep("page_read", page, 300);
    expect(kept.search("o1", "room 37:")).toBe("(part 4) Room 37: booking code 1036.");
    expect(kept.search("o1", "CODE 1001")).toBe("(part 1) Room 2: booking code 1001.");
    expect(kept.search("o1", "nothing here")).toMatch(/^No line/);
  });

  it("forgets the oldest outputs first, and says so", () => {
    const kept = new KeptOutputs();
    for (let i = 0; i < 31; i++) kept.keep("t", page, 300);
    expect(() => kept.read("o1", 2)).toThrow(/no longer kept/);
    expect(kept.read("o31", 2)).toContain("Room");
  });

  it("is read through two small tools", async () => {
    const kept = new KeptOutputs();
    kept.keep("page_read", page, 300);
    const [read, search] = keptOutputTools(kept);
    expect(read!.untrustedOutput).toBe(true);
    expect(await read!.run({ id: "o1", part: 2 }, {} as never)).toContain("Room");
    expect(await search!.run({ id: "o1", query: "1039" }, {} as never)).toBe("(part 4) Room 40: booking code 1039.");
  });
});

describe("kept output helpers", () => {
  const text = ["alpha one", "beta two", "gamma three", "delta four"].join("\n");

  it("say how to read on, in the same words for every keeper", () => {
    expect(keptNote("o3", 10, 1234)).toBe('[Showing characters 1–10 of 1,234. The whole output is kept as "o3": output_read with id "o3" and part 2–124 reads the rest in order; output_search finds the lines that contain given words.]');
  });

  it("read a part and say whether more follows", () => {
    expect(readPart(text, 10, "o1", 2)).toBe("beta two\ng\n[Part 2 of 5. output_read part 3 continues.]");
    expect(() => readPart(text, 10, "o1", 6)).toThrow('Output "o1" has parts 1–5.');
  });

  it("find lines with all the words, with their part", () => {
    expect(searchLines(text, 10, "o1", "GAMMA three")).toBe("(part 2) gamma three");
    expect(searchLines(text, 10, "o1", "omega")).toBe('No line in "o1" contains all of: omega.');
  });
});
