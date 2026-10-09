/**
 * A frame from another site, in a real headless Chrome. Skipped unless
 * VUNEMI_LIVE_BROWSER=1, since it launches a browser.
 *
 * The page is served on 127.0.0.1 and frames a widget from localhost: to
 * Chrome those are two sites, so the widget runs in a process of its own,
 * as an embedded payment form or a consent banner does. Inside it are a
 * frame of its own site and one from the page's site again.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";

const page = (port: number) => `<!doctype html>
<html><head><title>Shop</title></head><body style="margin:0">
  <h1>Checkout</h1>
  <button>Outer button</button>
  <iframe title="Widget" src="http://localhost:${port}/widget" style="position:absolute;left:60px;top:120px;width:520px;height:420px;border:4px solid #333"></iframe>
  <div style="position:fixed;left:60px;top:440px;width:300px;height:50px;background:#fc0">Cookie banner</div>
  <iframe title="Tracker" src="http://localhost:${port}/tracker" style="width:0;height:0;border:0"></iframe>
</body></html>`;

const widget = (port: number) => `<!doctype html>
<html><head><title>Widget</title></head><body style="margin:0;padding:10px">
  <p>Delivery is on Friday</p>
  <input id="note" aria-label="Gift note">
  <p id="echo"></p>
  <button onclick="document.getElementById('said').textContent='Code applied'">Apply code</button>
  <p id="said"></p>
  <form><label>Card number <input autocomplete="cc-number"></label>
  <label>Password <input type="password"></label></form>
  <button style="position:absolute;left:20px;top:330px">Under the banner</button>
  <iframe title="Deep" src="/deep" style="position:absolute;left:260px;top:10px;width:220px;height:90px;border:0"></iframe>
  <iframe title="Leaf" src="http://127.0.0.1:${port}/leaf" style="position:absolute;left:260px;top:110px;width:220px;height:90px;border:2px solid #999"></iframe>
  <script>
    document.getElementById('note').addEventListener('keyup', (e) => { document.getElementById('echo').textContent = 'Echo: ' + e.target.value; });
  </script>
</body></html>`;

const small = (name: string) => `<!doctype html>
<html><body style="margin:0"><button onclick="document.getElementById('said').textContent='${name} pressed'">${name} button</button><p id="said"></p></body></html>`;

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("a frame from another site, in live Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let browser: BrowserController;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const port = (server.address() as { port: number }).port;
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/widget" ? widget(port) : req.url === "/deep" ? small("Deep") : req.url === "/leaf" ? small("Leaf") : req.url === "/tracker" ? small("Tracker") : page(port));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "vunemi-frames-"));
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
  const read = async (): Promise<string> => {
    let text = "";
    await browser.act("read", async (d) => void (text = (await d.readText(4_000)).text));
    return text;
  };
  /** The outline once the frames have had time to load. */
  const outline = async (): Promise<string> => {
    await browser.goto(base, false);
    for (let i = 0; i < 20; i++) {
      const text = await browser.describe();
      if (/Leaf button/.test(text) && /Deep button/.test(text)) return text;
      await new Promise((r) => setTimeout(r, 250));
    }
    return browser.describe();
  };

  it("shows what is inside it, each element once and under its own ref", { timeout: 60_000 }, async () => {
    const text = await outline();
    for (const name of [/Outer button/, /Gift note/, /button "Apply code"/, /Deep button/, /Leaf button/]) expect(text.match(new RegExp(name, "g"))?.length, String(name)).toBe(1);
    const refs = [...text.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length);
    // The same refs the next time the page is looked at.
    expect(await browser.describe()).toBe(text);
    expect(await read()).toContain("Delivery is on Friday");
  });

  it("leaves out one that has no box on the page", { timeout: 60_000 }, async () => {
    const text = await outline();
    expect(text).not.toMatch(/Tracker button/);
    expect(await read()).not.toContain("Tracker button");
  });

  it("types into it and clicks in it, where the element is drawn", { timeout: 60_000 }, async () => {
    const text = await outline();
    await browser.act("typed", (d) => d.type(refOf(text, /Gift note/), "hello"));
    expect(await read()).toContain("Echo: hello");
    await browser.act("clicked", (d) => d.click(refOf(text, /button "Apply code"/)));
    expect(await read()).toContain("Code applied");
  });

  it("reaches a frame inside it, of its own site and of another", { timeout: 60_000 }, async () => {
    const text = await outline();
    await browser.act("clicked", (d) => d.click(refOf(text, /Deep button/)));
    expect(await read()).toContain("Deep pressed");
    await browser.act("clicked", (d) => d.click(refOf(text, /Leaf button/)));
    expect(await read()).toContain("Leaf pressed");
  });

  it("refuses an element in it that the page draws something over", { timeout: 60_000 }, async () => {
    const text = await outline();
    const err = await browser.act("clicked", (d) => d.click(refOf(text, /Under the banner/))).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/covered by something else/);
  });

  it("types no password and no card number there either", { timeout: 60_000 }, async () => {
    const text = await outline();
    const card = await browser.act("typed", (d) => d.type(refOf(text, /textbox "Card number"/), "4242 4242 4242 4242")).catch((e: unknown) => e);
    expect(String((card as Error).message)).toMatch(/card/i);
    const password = await browser.act("typed", (d) => d.type(refOf(text, /textbox "Password"/), "secret")).catch((e: unknown) => e);
    expect(String((password as Error).message)).toMatch(/password field/i);
  });

  it("covers its password and card fields before a picture is taken", { timeout: 60_000 }, async () => {
    await outline();
    let masks = -1;
    await browser.act("masked", async (d) => {
      const run = (d as unknown as { evaluate(e: string): Promise<number> }).evaluate.bind(d);
      await d.screenshot(10_000, async () => {
        masks = await run("document.querySelectorAll('[data-vunemi-mask]').length");
        return Buffer.alloc(0);
      });
    });
    expect(masks).toBe(2);
  });
});
