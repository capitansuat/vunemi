import { describe, expect, it } from "vitest";
import { createBrowserTools, outlineHead } from "../src/tools.js";
import type { BrowserController } from "../src/controller.js";

describe("an old page outline", () => {
  it("shortens a page's text to the line that says which page it was", () => {
    expect(outlineHead("[tab 1] Kettles — https://shop.example/kettles\nBlue kettle 30\nRed kettle 25")).toBe("[tab 1] Kettles — https://shop.example/kettles");
  });

  it("keeps what an action did and where it led", () => {
    const out = 'Clicked [12] link "Kettles"\n→ Now on: [tab 1] Kettles — https://shop.example/kettles\nInteractive elements (use page_describe for the full page, page_read for its text):\n- link "Blue" [ref=3]';
    expect(outlineHead(out)).toBe('Clicked [12] link "Kettles"\n→ Now on: [tab 1] Kettles — https://shop.example/kettles');
  });

  it("keeps a verdict that had no page line", () => {
    const out = 'Clicked [4] button "More"\n→ The page changed: 3 element(s) appeared, 0 disappeared.\nNew interactive elements:\n*[9] link "Next"';
    expect(outlineHead(out)).toBe('Clicked [4] button "More"\n→ The page changed: 3 element(s) appeared, 0 disappeared.');
  });

  it("never keeps more than a few hundred characters", () => {
    expect(outlineHead("y".repeat(5_000)).length).toBeLessThanOrEqual(300);
  });

  it("is what every tool that shows the page shortens to", () => {
    const tools = createBrowserTools({} as BrowserController);
    for (const name of ["page_goto", "page_search", "page_back", "page_describe", "page_read", "page_click", "page_type", "page_select", "page_press", "page_scroll"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.ephemeral, name).toBe(true);
      expect(tool.stale, name).toBe(outlineHead);
    }
    expect(tools.find((t) => t.name === "page_find")!.ephemeral).toBeFalsy();
  });
});
