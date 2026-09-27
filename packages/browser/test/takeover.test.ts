import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@vunemi/agent-core";
import type { BrowserController } from "../src/index.js";
import { createBrowserTools, NOTHING_TO_TAKE_OVER } from "../src/tools.js";

function takeover(browser: Partial<BrowserController>) {
  const tool = createBrowserTools(browser as BrowserController).find((t) => t.name === "user_takeover")!;
  const handoff = vi.fn(async () => true);
  const ctx = { handoff } as unknown as ToolContext;
  return { run: () => tool.run({ reason: "Giriş yap" }, ctx), handoff };
}

describe("handing the browser to the user", () => {
  it("refuses when no browser is running, without starting one", async () => {
    const tabs = vi.fn();
    const { run, handoff } = takeover({ kind: null, tabs });
    expect(await run()).toBe(NOTHING_TO_TAKE_OVER);
    expect(tabs).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("refuses when only blank tabs are open", async () => {
    const { run, handoff } = takeover({ kind: "isolated", tabs: async () => [{ id: 1, url: "about:blank", title: "", current: true }] });
    expect(await run()).toBe(NOTHING_TO_TAKE_OVER);
    expect(handoff).not.toHaveBeenCalled();
  });

  it("hands over a real page", async () => {
    const { run, handoff } = takeover({
      kind: "isolated",
      tabs: async () => [{ id: 1, url: "https://example.com/login", title: "Log in", current: true }],
      describe: async () => "page",
    });
    expect(await run()).toContain("The user is done.");
    expect(handoff).toHaveBeenCalledWith("Giriş yap");
  });
});
