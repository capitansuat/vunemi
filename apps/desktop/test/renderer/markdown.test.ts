/**
 * The chat's Markdown blocks. Tables are the case that brought this file
 * about: a local model answered "what's on my calendar" with one, and the
 * chat showed the raw pipes.
 */
import { describe, expect, it } from "vitest";
import { cutAtUnverified, parseBlocks, plainMath } from "../../src/renderer/src/lib/markdown";

describe("parseBlocks — tables", () => {
  it("reads the table a model actually wrote", () => {
    const blocks = parseBlocks(
      [
        "Bugünün takviminde 2 etkinlik var:",
        "",
        "| Saat | Etkinlik | Yer |",
        "|------|---------|-----|",
        "| 08:00–08:30 | EACIT Update Meeting | Microsoft Teams |",
        "| 14:30–15:30 | Focus time | — |",
        "",
        "Yoğun bir gün.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table", "p"]);
    expect(blocks[1]).toEqual({
      kind: "table",
      head: ["Saat", "Etkinlik", "Yer"],
      align: ["left", "left", "left"],
      rows: [
        ["08:00–08:30", "EACIT Update Meeting", "Microsoft Teams"],
        ["14:30–15:30", "Focus time", "—"],
      ],
    });
  });

  it("starts a table right after a paragraph line, with no blank line between", () => {
    const blocks = parseBlocks("Etkinlikler:\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table"]);
  });

  it("reads alignment from the separator", () => {
    const [table] = parseBlocks("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |");
    expect(table).toMatchObject({ kind: "table", align: ["left", "center", "right"] });
  });

  it("keeps an escaped pipe inside its cell", () => {
    const [table] = parseBlocks("| komut | anlamı |\n| --- | --- |\n| a \\| b | boru |");
    expect(table).toMatchObject({ rows: [["a | b", "boru"]] });
  });

  it("leaves a header that has not streamed its separator yet as text", () => {
    expect(parseBlocks("| Saat | Etkinlik |").map((b) => b.kind)).toEqual(["p"]);
  });

  it("does not take a line of pipes without a separator for a table", () => {
    expect(parseBlocks("| bir | iki |\n| üç | dört |").map((b) => b.kind)).toEqual(["p"]);
  });
});

describe("parseBlocks — the rest still works", () => {
  it("parses headings, lists, code and quotes", () => {
    const kinds = parseBlocks("# Başlık\n\n- a\n- b\n\n1. bir\n\n```ts\nx\n```\n\n> alıntı").map((b) => b.kind);
    expect(kinds).toEqual(["h", "ul", "ol", "code", "quote"]);
  });
});

describe("plainMath", () => {
  it("turns the LaTeX a model writes into text the chat can show", () => {
    // Live, 27 Sep: Gemma answered "what is photosynthesis" with $\\text{CO}_2$.
    expect(plainMath("Karbondioksit ($\\text{CO}_2$) ve su ($\\text{H}_2\\text{O}$)")).toBe("Karbondioksit (CO₂) ve su (H₂O)");
    expect(plainMath("$6\\text{CO}_2 + 6\\text{H}_2\\text{O} \\rightarrow \\text{C}_6\\text{H}_{12}\\text{O}_6$")).toBe("6CO₂ + 6H₂O → C₆H₁₂O₆");
    expect(plainMath("$x^2 \\times 3 \\leq 10$ and $$E = mc^2$$")).toBe("x² × 3 ≤ 10 and E = mc²");
    expect(plainMath("25\\,°C")).toBe("25\\,°C");
  });

  it("leaves money and ordinary dollars alone", () => {
    expect(plainMath("It costs $5 and $10.")).toBe("It costs $5 and $10.");
    expect(plainMath("Price: $3.50")).toBe("Price: $3.50");
  });
});

describe("cutAtUnverified", () => {
  const unverified = ["https://maker.example/air", "http://maker.example/b"];

  it("cuts the text after each address the conversation never held", () => {
    expect(cutAtUnverified("Go to https://maker.example/air. Or (http://maker.example/b), then stop.", unverified)).toEqual([
      { text: "Go to https://maker.example/air", unverified: true },
      { text: ". Or (http://maker.example/b", unverified: true },
      { text: "), then stop.", unverified: false },
    ]);
  });

  it("leaves an address that only begins like one, and text without any", () => {
    expect(cutAtUnverified("See https://maker.example/air-15 and https://shop.example/x", unverified)).toEqual([{ text: "See https://maker.example/air-15 and https://shop.example/x", unverified: false }]);
    expect(cutAtUnverified("Nothing here", unverified)).toEqual([{ text: "Nothing here", unverified: false }]);
    expect(cutAtUnverified("https://maker.example/air", unverified)).toEqual([{ text: "https://maker.example/air", unverified: true }]);
  });
});
