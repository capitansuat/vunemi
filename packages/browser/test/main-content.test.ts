import { describe, expect, it } from "vitest";
import { markdownOf, type ContentNode } from "../src/main-content.js";

const text = (t: string): ContentNode => ({ t: "text", text: t });

describe("markdownOf", () => {
  it("writes headings by level", () => {
    expect(markdownOf([{ t: "h", level: 1, kids: [text("Accountant")] }, { t: "h", level: 2, kids: [text("Requirements")] }])).toBe("# Accountant\n\n## Requirements");
  });

  it("writes lists, nested ones indented by two spaces", () => {
    const md = markdownOf([
      { t: "ul", kids: [{ t: "li", kids: [text("a"), { t: "ul", kids: [{ t: "li", kids: [text("a1")] }] }] }, { t: "li", kids: [text("b")] }] },
      { t: "ol", kids: [{ t: "li", kids: [text("first")] }, { t: "li", kids: [text("second")] }] },
    ]);
    expect(md).toBe("- a\n  - a1\n- b\n\n1. first\n2. second");
  });

  it("writes a table with its header row", () => {
    const md = markdownOf([
      { t: "table", kids: [
        { t: "tr", kids: [{ t: "th", kids: [text("Job")] }, { t: "th", kids: [text("Salary")] }] },
        { t: "tr", kids: [{ t: "td", kids: [text("Accountant")] }, { t: "td", kids: [text("40,000 | gross")] }] },
      ] },
    ]);
    expect(md).toBe("| Job | Salary |\n| --- | --- |\n| Accountant | 40,000 \\| gross |");
  });

  it("writes web links and bold labels", () => {
    expect(markdownOf([{ t: "p", kids: [{ t: "strong", kids: [text("Salary:")] }, text(" 40,000 "), { t: "a", href: "https://jobs.example/1", kids: [text("Apply")] }] }])).toBe(
      "**Salary:** 40,000 [Apply](https://jobs.example/1)",
    );
  });

  it("keeps a link's text but not an address that isn't http(s)", () => {
    expect(markdownOf([{ t: "p", kids: [{ t: "a", href: "javascript:void(0)", kids: [text("More")] }] }])).toBe("More");
  });

  it("writes an image as its alt text, and nothing without one", () => {
    expect(markdownOf([{ t: "p", kids: [{ t: "img", alt: "Company logo" }, { t: "img", alt: "" }, text("Acme")] }])).toBe("Company logo Acme");
  });

  it("collapses whitespace and drops empty paragraphs", () => {
    expect(markdownOf([{ t: "p", kids: [text("  Full\n\n  time ")] }, { t: "p", kids: [text("   ")] }, { t: "p", kids: [text("Remote")] }])).toBe("Full time\n\nRemote");
  });

  it("breaks a line where the page does", () => {
    expect(markdownOf([{ t: "p", kids: [text("Acme Ltd"), { t: "br" }, text("London")] }])).toBe("Acme Ltd\nLondon");
  });
});

describe("page_read", () => {
  it("shows the main content and keeps the whole page text after the mark", async () => {
    const { createBrowserTools, WHOLE_PAGE_MARK } = await import("../src/tools.js");
    const browser = {
      kind: null,
      challenge: null,
      read: async () => `[tab 1] Jobs — https://jobs.example/\n# Accountant\n[Read: main]${WHOLE_PAGE_MARK}Menu Cookies Accountant Footer`,
    };
    const tool = createBrowserTools(browser as never).find((t) => t.name === "page_read")!;
    const out = await tool.run({}, { handoff: async () => true } as never);
    expect(out.startsWith("[tab 1] Jobs — https://jobs.example/\n# Accountant")).toBe(true);
    expect(out).toContain("[Read: main]");
    expect(tool.firstPartEnd).toBe(WHOLE_PAGE_MARK);
    expect(tool.firstPartChars).toBe(6_000);
    expect(out.slice(0, out.indexOf(tool.firstPartEnd!))).not.toContain("Cookies");
  });
});
