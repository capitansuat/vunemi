/**
 * The skeleton of a linked folder, made by code and no model: headings,
 * links between files, and the codes the files use (topics/skeleton.ts).
 */
import { describe, expect, it } from "vitest";
import { codesOf, linksOf, outlineOf, resolveLink } from "../../src/main/topics/skeleton.js";

describe("outlines", () => {
  it("lists the headings in order, at most as many as asked", () => {
    expect(outlineOf("# Loan periods\n\ntext\n\n## QXA ##\n### Rows\n#not a heading")).toEqual(["Loan periods", "QXA", "Rows"]);
    expect(outlineOf("# a\n# b\n# c", 2)).toEqual(["a", "b"]);
  });
});

describe("links between files", () => {
  it("finds the links between files, whatever form they take", () => {
    expect(linksOf('<a href="loan-period-reference.html">x</a> [y](./a/b.md) [[branch-reference]] [w](https://x.org) [m](mailto:a@b.c) [t](#top) [q](c.html#part)')).toEqual([
      "loan-period-reference.html",
      "./a/b.md",
      "branch-reference",
      "c.html",
    ]);
  });

  it("resolves a link to a file of the folder, by its path or the same name in another kind", () => {
    const rels = new Set(["loan-period-reference.md", "a/b.md", "a/c.csv"]);
    expect(resolveLink("opening-hours-reference.md", "loan-period-reference.html", rels)).toBe("loan-period-reference.md");
    expect(resolveLink("a/x.md", "b.md", rels)).toBe("a/b.md");
    expect(resolveLink("a/x.md", "../loan-period-reference", rels)).toBe("loan-period-reference.md");
    expect(resolveLink("x.md", "a/c.html", rels)).toBe("a/c.csv");
    expect(resolveLink("x.md", "../../outside.md", rels)).toBeNull();
    expect(resolveLink("x.md", "nowhere.md", rels)).toBeNull();
  });
});

describe("codes", () => {
  it("knows a code where it is defined from one that is only mentioned", () => {
    expect(codesOf("## QXA\n\n| QXB | Standard |\n\nSee QXA and THE end")).toEqual([
      { code: "QXA", count: 2, defined: true },
      { code: "QXB", count: 1, defined: true },
    ]);
    expect(codesOf("Mentioned QXC only, and PDF or HTML files")).toEqual([{ code: "QXC", count: 1, defined: false }]);
  });

  it("keeps the codes a file uses most when it uses very many", () => {
    const many = Array.from({ length: 300 }, (_, i) => `C${String(i).padStart(3, "0")}`).join(" ") + " ZZZ ZZZ ZZZ";
    const codes = codesOf(many);
    expect(codes.length).toBe(200);
    expect(codes[0]).toEqual({ code: "ZZZ", count: 3, defined: false });
  });
});
