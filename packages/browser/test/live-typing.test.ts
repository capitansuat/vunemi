/**
 * Typing the way enterprise web apps expect it, in a real headless Chrome.
 * Skipped unless VUNEMI_LIVE_BROWSER=1, since it launches a browser.
 *
 * The fixture copies what a PeopleSoft menu search does: an overlay covers
 * the page's own search box and brings a search field of its own, whose list
 * filters on keyup and never on the input event.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";

const FIXTURE = `<!doctype html>
<html><head><title>Portal</title></head><body>
  <header><input id="global" role="combobox" aria-label="Search keywords"></header>
  <div id="menu" style="position:fixed;inset:0;background:#eee;padding:20px">
    <input id="menuq" aria-label="Search in Menu">
    <ul id="list"><li>Create</li><li>Query Manager</li><li>Query Viewer</li><li>Visa Permit Data</li></ul>
  </div>
  <script>
    const items = [...document.querySelectorAll('#list li')];
    document.getElementById('menuq').addEventListener('keyup', (e) => {
      const q = e.target.value.toLowerCase();
      for (const li of items) li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  </script>
</body></html>`;

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("typing in live Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let browser: BrowserController;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "vunemi-chrome-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
  }, 60_000);

  afterAll(async () => {
    await browser?.dispose();
    server?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  const refOf = (text: string, pattern: RegExp): number => {
    const line = text.split("\n").find((l) => pattern.test(l));
    if (!line) throw new Error(`No line matching ${pattern} in:\n${text}`);
    return Number(line.match(/\[(\d+)\]/)![1]);
  };

  it("refuses to type into a field hidden under an overlay, and says so", { timeout: 60_000 }, async () => {
    const landing = await browser.goto(base, false);
    const hidden = refOf(landing, /Search keywords/);
    const err = await browser.act("typed", (d) => d.type(hidden, "Query Manager")).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/covered by something else/);
  });

  it("types key by key, so a list that filters on keyup filters", { timeout: 30_000 }, async () => {
    const page = await browser.describe();
    await browser.act("typed", (d) => d.type(refOf(page, /Search in Menu/), "query"));
    let text = "";
    await browser.act("read", async (d) => void (text = (await d.readText(2_000)).text));
    expect(text).toContain("Query Manager");
    expect(text).toContain("Query Viewer");
    expect(text).not.toContain("Visa Permit Data");
  });
});
