/**
 * What kind of element the model acts on, read from a real headless Chrome.
 * Skipped unless VUNEMI_LIVE_BROWSER=1, since it launches a browser.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";
import { createBrowserTools } from "../src/tools.js";
import { checkNavigation } from "../src/url-policy.js";

const PAGES: Record<string, string> = {
  "/links": `<title>Links</title>
    <a href="/next">Plain link</a>
    <a href="https://example.com/away">Away link</a>
    <a href="javascript:void(0)">Script link</a>
    <a href="#">Hash link</a>
    <a href="#below">Below link</a>
    <a href="/file.zip" download>Download link</a>
    <a href="/inline" onclick="return false">Inline handler link</a>
    <a href="/listened" id="listened">Listened link</a>
    <a href="/as-button" role="button">Button link</a>
    <a href="mailto:someone@example.com">Mail link</a>
    <a href="http://192.168.1.10/">Router link</a>
    <form method="post" action="/order"><a href="/terms">Terms in order form</a></form>
    <p id="below">Below</p>
    <script>document.getElementById("listened").addEventListener("click", (e) => { e.preventDefault(); document.forms[0].submit(); });</script>`,
  "/forms": `<title>Forms</title>
    <form action="/search"><input name="q" aria-label="Default search"><button>Go</button></form>
    <form method="GET" action="/find"><input type="search" name="q" aria-label="Find box"><textarea name="t" aria-label="Find notes"></textarea></form>
    <form action="/s"><div role="searchbox" contenteditable="true" aria-label="Rich search"></div></form>
    <form method="post" action="/comment"><input name="c" aria-label="Comment"><textarea aria-label="Comment body"></textarea><button aria-label="Send comment">Send</button><input type="submit" value="Post it"><select aria-label="Visibility"><option>All</option></select></form>
    <form action="/mixed"><input name="m" aria-label="Mixed field"><button formmethod="post">Mixed send</button></form>
    <form action="/maybe"><input name="x" aria-label="Plain field"><button>Plain go</button><button formmethod="post">Second send</button></form>
    <form method="dialog"><input aria-label="Dialog field"></form>
    <form action="/shadowed"><input name="method" value="post" aria-label="Field named method"></form>
    <input aria-label="Loose field">
    <input aria-label="Attached field" form="far">
    <form id="far" method="post" action="/far"></form>`,
  // A page that lies to scripts in its own world: POST forms read as GET, and the focus seems to stay in the search field.
  "/lying": `<title>Lying</title>
    <form method="post" action="/x"><input name="q" aria-label="Lying field"></form>
    <form action="/s"><input name="s" aria-label="Lie search"></form>
    <form method="post" action="/c"><input name="c" aria-label="Lie comment"></form>
    <script>
      const get = Element.prototype.getAttribute, has = Element.prototype.hasAttribute;
      Element.prototype.getAttribute = function (n) { return n === "method" || n === "formmethod" ? "get" : get.call(this, n); };
      Element.prototype.hasAttribute = function (n) { return n === "formmethod" ? false : has.call(this, n); };
      Object.defineProperty(HTMLFormElement.prototype, "elements", { get() { return []; } });
      const search = document.querySelector('[aria-label="Lie search"]');
      Object.defineProperty(Document.prototype, "activeElement", { get() { return search; } });
      search.addEventListener("input", () => setTimeout(() => document.querySelector('[aria-label="Lie comment"]').focus(), 0));
    </script>`,
};

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("element kinds, in live Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let browser: BrowserController;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><body>${PAGES[req.url ?? ""] ?? "<title>Other</title><p>Other page</p>"}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "vunemi-kinds-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
  }, 60_000);

  afterAll(async () => {
    await browser?.dispose();
    server?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  const refs = async (path: string): Promise<(name: string) => number> => {
    await browser.goto(base + path, false);
    const text = await browser.describe();
    return (name: string) => {
      const line = text.split("\n").find((l) => l.includes(`"${name}"`) && /\[\d+\]/.test(l));
      if (!line) throw new Error(`No element named ${name} in:\n${text}`);
      return Number(line.match(/\[(\d+)\]/)![1]);
    };
  };

  it("knows an ordinary link from one that runs script, stays on the page, downloads or posts", { timeout: 60_000 }, async () => {
    const ref = await refs("/links");
    const kinds = Object.fromEntries(
      ["Plain link", "Away link", "Script link", "Hash link", "Below link", "Download link", "Inline handler link", "Listened link", "Button link", "Mail link", "Router link", "Terms in order form"]
        .map((name) => [name, browser.kindFor(ref(name))]),
    );
    expect(kinds).toEqual({
      "Plain link": "link", "Away link": "link", "Router link": "link",
      "Script link": "other", "Hash link": "other", "Below link": "other", "Download link": "other",
      "Inline handler link": "other", "Listened link": "other", "Button link": "other", "Mail link": "other",
      "Terms in order form": "posts",
    });
    expect(browser.host()).toBe("127.0.0.1");
  });

  it("knows a search field by its form's method, and what a form that posts holds", { timeout: 60_000 }, async () => {
    const ref = await refs("/forms");
    const kinds = Object.fromEntries(
      ["Default search", "Go", "Find box", "Find notes", "Rich search", "Comment", "Comment body", "Send comment", "Post it", "Visibility", "Mixed field", "Mixed send", "Plain field", "Dialog field", "Field named method", "Loose field", "Attached field"]
        .map((name) => [name, browser.kindFor(ref(name))]),
    );
    expect(kinds).toEqual({
      "Default search": "search", "Find box": "search", "Find notes": "search", "Rich search": "search", "Field named method": "search", "Plain field": "search",
      Go: "other", "Dialog field": "other", "Loose field": "other",
      Comment: "posts", "Comment body": "posts", "Send comment": "posts", "Post it": "posts", Visibility: "posts",
      "Mixed field": "posts", "Mixed send": "posts", "Attached field": "posts",
    });
  });

  it("refuses a link to a private-network address before any card, as page_goto does; follows a plain one with no card", { timeout: 60_000 }, async () => {
    const ref = await refs("/links");
    const tools = createBrowserTools(browser);
    const click = tools.find((t) => t.name === "page_click")!;
    expect(click.classify!({ ref: ref("Router link") })).toBe("read");
    expect(await click.check!({ ref: ref("Router link") })).toBe(checkNavigation("http://192.168.1.10/"));
    expect(click.classify!({ ref: ref("Listened link") })).toBe("outbound");
    // The test server is this computer, so its own links are refused the same way; a public one is not.
    expect(await click.check!({ ref: ref("Plain link") })).toMatch(/this computer's own address/);
    expect(await click.check!({ ref: ref("Away link") })).toBeNull();
  });

  it("reads elements where the page's own scripts can't lie about them", { timeout: 60_000 }, async () => {
    const ref = await refs("/lying");
    expect(browser.kindFor(ref("Lying field"))).toBe("posts");
    expect(browser.kindFor(ref("Lie search"))).toBe("search");
    const tools = createBrowserTools(browser);
    const type = tools.find((t) => t.name === "page_type")!;
    const press = tools.find((t) => t.name === "page_press")!;
    await type.run({ ref: ref("Lie search"), text: "weather" }, {} as never);
    await new Promise((r) => setTimeout(r, 300));
    // The page moved the focus into a form that posts and pretends it didn't: Enter is not a search there.
    expect(await press.check!({ key: "Enter" })).toMatch(/focus is no longer in the search field/);
    expect(await browser.focusedLiveKind()).toBe("posts");
  });

  it("counts Enter as a search only in the GET field just typed into", { timeout: 60_000 }, async () => {
    const ref = await refs("/forms");
    const tools = createBrowserTools(browser);
    const type = tools.find((t) => t.name === "page_type")!;
    const press = tools.find((t) => t.name === "page_press")!;
    expect(type.classify!({ ref: ref("Default search"), text: "weather" })).toBe("read");
    expect(type.classify!({ ref: ref("Comment"), text: "hello" })).toBe("outbound");
    await type.run({ ref: ref("Default search"), text: "weather" }, {} as never);
    expect(press.classify!({ key: "Enter" })).toBe("read");
    expect(await press.check!({ key: "Enter" })).toBeNull();
    expect(await browser.focusedLiveKind()).toBe("search");
    await type.run({ ref: ref("Loose field"), text: "x" }, {} as never);
    expect(press.classify!({ key: "Enter" })).toBe("outbound");
  });
});
