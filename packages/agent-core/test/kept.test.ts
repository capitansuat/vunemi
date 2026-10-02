import { describe, expect, it } from "vitest";
import { KeptOutputs, keptOutputTools } from "../src/kept.js";

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
