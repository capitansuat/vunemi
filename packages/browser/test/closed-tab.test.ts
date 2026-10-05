import { describe, expect, it } from "vitest";
import type { BrowserBackend, TabInfo } from "../src/backend.js";
import { BrowserController } from "../src/controller.js";
import { PageActionError } from "../src/page.js";

/** Tabs only; attaching fails the way the embedded browser does for a closed tab. */
function backend(tabs: TabInfo[]): BrowserBackend {
  return {
    kind: "embedded",
    connected: true,
    listTabs: async () => tabs.map((t) => ({ ...t })),
    openTab: async () => { throw new Error("not in this test"); },
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    attach: async (id) => { throw new Error(`No embedded tab ${id}.`); },
    onDetach: () => () => undefined,
    close: async () => undefined,
  };
}

describe("a tab closed under a running task", () => {
  it("does nothing and says the tab was closed, instead of acting in another tab", async () => {
    const tabs: TabInfo[] = [
      { targetId: "7", url: "https://example.com/a", title: "A" },
      { targetId: "8", url: "https://example.com/b", title: "B" },
    ];
    const browser = new BrowserController(async () => backend(tabs));
    const before = await browser.tabs();
    expect(before.find((t) => t.current)?.title).toBe("A");

    tabs.splice(0, 1);
    const err = await browser.describe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageActionError);
    expect(String((err as Error).message)).toMatch(/tab you were working in \(tab 1\) has been closed, so nothing was done/);

    // The next look at the tabs no longer lists it, and nothing points at it.
    expect((await browser.tabs()).map((t) => t.title)).toEqual(["B"]);
  });

  it("works in the tab the user brought forward, not the one the last task used", async () => {
    const tabs: TabInfo[] = [
      { targetId: "7", url: "https://example.com/a", title: "A" },
      { targetId: "9", url: "https://example.com/offer", title: "Offer" },
    ];
    const browser = new BrowserController(async () => backend(tabs));
    expect((await browser.tabs()).find((t) => t.current)?.title).toBe("A");
    browser.follow("9");
    expect((await browser.tabs()).find((t) => t.current)?.title).toBe("Offer");
  });
});
