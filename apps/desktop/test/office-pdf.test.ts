import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>;
    destroyed: boolean;
    url: string;
    onRequest?: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
  }>,
  failPrint: false,
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    item: (typeof state.windows)[number];
    webContents: {
      session: { webRequest: { onBeforeRequest: (callback: NonNullable<(typeof state.windows)[number]["onRequest"]>) => void } };
      setWindowOpenHandler: () => void;
      on: () => void;
      printToPDF: () => Promise<Buffer>;
    };
    constructor(options: Record<string, unknown>) {
      this.item = { options, destroyed: false, url: "" };
      state.windows.push(this.item);
      this.webContents = {
        session: { webRequest: { onBeforeRequest: (callback) => { this.item.onRequest = callback; } } },
        setWindowOpenHandler: () => {},
        on: () => {},
        printToPDF: async () => {
          if (state.failPrint) throw new Error("print failed");
          return Buffer.from("%PDF-test");
        },
      };
    }
    async loadURL(url: string) { this.item.url = url; }
    isDestroyed() { return this.item.destroyed; }
    destroy() { this.item.destroyed = true; }
  },
}));

import { renderOfficePdf } from "../src/main/office-pdf.js";

beforeEach(() => { state.windows.length = 0; state.failPrint = false; });

describe("isolated Office PDF renderer", () => {
  it("blocks network and scripts, then destroys its window", async () => {
    const result = await renderOfficePdf("<html><head></head><body>Test</body></html>", new AbortController().signal);
    expect(Buffer.from(result).subarray(0, 5).toString()).toBe("%PDF-");
    const item = state.windows[0]!;
    expect(item.options.show).toBe(false);
    expect(item.options.webPreferences).toMatchObject({ javascript: false, nodeIntegration: false, sandbox: true });
    const html = Buffer.from(item.url.split(",")[1]!, "base64").toString("utf8");
    expect(html).toContain("default-src 'none'");
    const reply = vi.fn();
    item.onRequest!({ url: "https://example.com/secret" }, reply);
    expect(reply).toHaveBeenCalledWith({ cancel: true });
    expect(item.destroyed).toBe(true);
  });

  it("destroys its window if printing fails", async () => {
    state.failPrint = true;
    await expect(renderOfficePdf("<p>Test</p>", new AbortController().signal)).rejects.toThrow("print failed");
    expect(state.windows[0]?.destroyed).toBe(true);
  });
});
