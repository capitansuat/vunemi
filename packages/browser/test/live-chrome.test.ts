/**
 * Drives a real headless Chrome against a local fixture page. Skipped unless
 * VUNEMI_LIVE_BROWSER=1, since it launches a browser.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";
import { createBrowserTools } from "../src/tools.js";

const FIXTURE = `<!doctype html>
<html><head><title>Fixture Shop</title></head><body>
  <h1>Fixture Shop</h1>
  <form onsubmit="event.preventDefault(); show()">
    <label>Search <input id="q" name="q"></label>
    <button type="submit">Go</button>
  </form>
  <div id="results"></div>
  <label>Password <input type="password" id="pw"></label>
  <label>Size
    <select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
  </label>
  <div style="position:relative">
    <button id="hidden-under">Buried button</button>
    <div style="position:absolute;inset:0;background:white">cookie banner</div>
  </div>
  <button onclick="void 0">Does nothing</button>
  <a href="/page2">Next page</a>
  <a href="/captcha">Robot check</a>
  <script>
    function show() {
      const q = document.getElementById('q').value;
      document.getElementById('results').innerHTML =
        '<h2>Results for ' + q + '</h2><button>Add ' + q + ' to cart</button>';
    }
  </script>
</body></html>`;

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("live Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let browser: BrowserController;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/captcha") {
        res.end("<title>Check</title><h1>One more step</h1><label><input type=checkbox> I'm not a robot</label>");
        return;
      }
      res.end(req.url === "/page2" ? "<title>Page Two</title><h1>Second page</h1><a href='/'>Home</a>" : FIXTURE);
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

  it("opens a page and lists its interactive elements with refs", { timeout: 60_000 }, async () => {
    const landing = await browser.goto(base, false);
    console.log(landing);
    expect(landing).toContain("Fixture Shop");
    expect(landing).toMatch(/\[\d+\] textbox "Search"/);
    expect(landing).toMatch(/\[\d+\] button "Go"/);
    expect(landing).toMatch(/\[\d+\] combobox "Size"/);
  });

  it("types and submits, and reports the new elements that appeared", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    const verdict = await browser.act("Typed.", (d) => d.type(refOf(page, /textbox "Search"/), "shoes", { submit: true }));
    console.log(verdict);
    expect(verdict).toMatch(/The page changed: \d+ element\(s\) appeared/);
    expect(verdict).toMatch(/\*\[\d+\] button "Add shoes to cart"/);
  });

  it("says so when a click changes nothing", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    const verdict = await browser.act("Clicked.", (d) => d.click(refOf(page, /button "Does nothing"/)));
    expect(verdict).toMatch(/No visible change/);
  });

  it("refuses to click an element hidden under an overlay", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    await expect(browser.act("Clicked.", (d) => d.click(refOf(page, /button "Buried button"/)))).rejects.toThrow(
      /covered by something else/,
    );
  });

  it("refuses to type into a password field", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    await expect(browser.act("Typed.", (d) => d.type(refOf(page, /textbox "Password"/), "hunter2"))).rejects.toThrow(
      /password field/,
    );
  });

  it("selects a dropdown option by label", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    let chosen = "";
    await browser.act("Selected.", async (d) => {
      chosen = await d.select(refOf(page, /combobox "Size"/), "large");
    });
    expect(chosen).toBe("Large");
    expect(await browser.describe({ interactiveOnly: true })).toMatch(/combobox "Size" value="Large"/);
  });

  it("follows a link and reports the navigation", { timeout: 30_000 }, async () => {
    const page = await browser.describe({ interactiveOnly: true });
    const verdict = await browser.act("Clicked.", (d) => d.click(refOf(page, /link "Next page"/)));
    console.log(verdict);
    expect(verdict).toMatch(/Now on: \[tab \d+\] Page Two/);
    expect(await browser.back()).toContain("Fixture Shop");
  });

  it("keeps a whole page within the describe budget", { timeout: 30_000 }, async () => {
    const full = await browser.describe();
    console.log(`full outline: ${full.length} chars`);
    expect(full.length).toBeLessThan(16_500);
  });

  it("hands a CAPTCHA to the user instead of trying to pass it", { timeout: 30_000 }, async () => {
    const click = createBrowserTools(browser).find((t) => t.name === "page_click")!;
    await browser.goto(`${base}/`, false);
    const page = await browser.describe({ interactiveOnly: true });
    const asked: string[] = [];
    const ctx = {
      signal: new AbortController().signal,
      handoff: async (reason: string) => {
        asked.push(reason);
        return false; // the user cancels
      },
      offerUndo: () => {},
      attach: () => {},
    };
    const out = await click.run({ ref: refOf(page, /link "Robot check"/) }, ctx);
    expect(browser.challenge).toBe("CAPTCHA");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/robot doğrulaması/);
    expect(out).toMatch(/did not complete it/);
    expect(await browser.back()).toContain("Fixture Shop");
  });
});
