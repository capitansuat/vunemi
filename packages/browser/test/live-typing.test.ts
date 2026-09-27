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

/**
 * The same menu, the way PeopleSoft actually draws it: inside an iframe on
 * the page (and the page's content in another), with a sign-in field there.
 */
const FRAMED = `<!doctype html>
<html><head><title>Framed portal</title></head><body style="margin:0">
  <h1>Portal</h1>
  <iframe id="nav" src="/nav" style="position:absolute;left:40px;top:80px;width:500px;height:300px;border:3px solid #333"></iframe>
</body></html>`;

const NAV = `<!doctype html>
<html><head><title>Nav</title></head><body>
  <input id="menuq" aria-label="Search in Menu">
  <ul id="list"><li>Create</li><li>Query Manager</li><li>Visa Permit Data</li></ul>
  <button onclick="document.getElementById('said').textContent='Opened Query Manager'">Open</button>
  <p id="said"></p>
  <label>Password <input type="password" id="pw"></label>
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
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/framed" ? FRAMED : req.url === "/nav" ? NAV : FIXTURE);
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

  it("sees, types into and clicks what is inside an iframe", { timeout: 30_000 }, async () => {
    const landing = await browser.goto(`${base}/framed`, false);
    expect(landing.match(/Search in Menu/g)?.length).toBe(1);
    await browser.act("typed", (d) => d.type(refOf(landing, /Search in Menu/), "query"));
    let text = "";
    await browser.act("read", async (d) => void (text = (await d.readText(2_000)).text));
    expect(text).toContain("Query Manager");
    expect(text).not.toContain("Visa Permit Data");

    const after = await browser.act("clicked", (d) => d.click(refOf(landing, /button "Open"/)));
    expect(after).toMatch(/Opened Query Manager|changed/);
    await browser.act("read", async (d) => void (text = (await d.readText(2_000)).text));
    expect(text).toContain("Opened Query Manager");
  });

  it("covers a password field inside an iframe before a picture is taken", { timeout: 30_000 }, async () => {
    await browser.goto(`${base}/framed`, false);
    let masks = -1;
    // Counted while the picture is being taken, through the driver's own page script runner.
    await browser.act("masked", async (d) => {
      const run = (d as unknown as { evaluate(e: string): Promise<number> }).evaluate.bind(d);
      await d.screenshot(10_000, async () => {
        masks = await run("document.querySelectorAll('[data-vunemi-mask]').length");
        return Buffer.alloc(0);
      });
    });
    expect(masks).toBe(1);
  });
});
