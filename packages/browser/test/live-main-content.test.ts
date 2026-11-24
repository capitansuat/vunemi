/**
 * page_read's main content, in a real headless Chrome. Skipped unless
 * VUNEMI_LIVE_BROWSER=1, since it launches a browser. Synthetic pages: a job
 * advert inside the usual chrome, and a results list with no <main>.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";
import { WHOLE_PAGE_MARK } from "../src/main-content.js";

const CHROME = `
  <header><a href="/">Jobs Example</a> <a href="/login">Sign in to Jobs Example</a></header>
  <nav><a href="/a">Browse all categories</a> <a href="/b">Career advice</a></nav>
  <div id="cookie-banner">We use cookies to improve your experience. Accept all cookies?</div>`;
const FOOTER = `<footer>About us · Privacy policy · Terms of use · Copyright Jobs Example</footer>`;

const PAGES: Record<string, string> = {
  "/job": `<title>Accountant at Acme</title>${CHROME}
    <main>
      <h1>Accountant</h1>
      <p><strong>Company:</strong> Acme Ltd</p>
      <p><strong>Salary:</strong> 40,000 a year</p>
      <h2>Requirements</h2>
      <ul><li>Three years in practice</li><li>A chartered qualification</li></ul>
      <p><a href="https://jobs.example/apply/1">Apply for this job</a></p>
    </main>
    <aside><h3>Similar jobs</h3><p>Bookkeeper at Other Corp, Payroll clerk at Third Inc</p></aside>${FOOTER}`,
  "/results": `<title>Results</title>${CHROME}
    <div class="layout"><div class="results">
      <div class="card"><h3>Accountant, Acme Ltd</h3><p>London. 40,000 a year. Three years in practice, chartered qualification required for this role.</p></div>
      <div class="card"><h3>Analyst, Beta plc</h3><p>Leeds. 35,000 a year. Two years of financial modelling and strong spreadsheet skills required.</p></div>
      <div class="card"><h3>Auditor, Gamma LLP</h3><p>Bristol. 45,000 a year. Statutory audit experience across mid-sized clients required.</p></div>
    </div></div>${FOOTER}`,
};

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("page_read's main content, in live Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let browser: BrowserController;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><body>${PAGES[req.url ?? ""] ?? ""}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    profile = mkdtempSync(join(tmpdir(), "vunemi-content-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
  }, 60_000);

  afterAll(async () => {
    await browser?.dispose();
    server?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  const read = async (path: string) => {
    await browser.goto(`${base}${path}`, false);
    const out = await browser.read(100_000);
    const at = out.indexOf(WHOLE_PAGE_MARK);
    return { shown: out.slice(0, at), whole: out.slice(at + WHOLE_PAGE_MARK.length) };
  };

  it("reads a job advert's <main> as Markdown, without the page around it", async () => {
    const { shown, whole } = await read("/job");
    expect(shown).toContain("# Accountant");
    expect(shown).toContain("**Company:** Acme Ltd");
    expect(shown).toContain("**Salary:** 40,000 a year");
    expect(shown).toContain("- Three years in practice");
    expect(shown).toContain("[Apply for this job](https://jobs.example/apply/1)");
    expect(shown).toContain("[Read: main]");
    for (const chrome of ["Browse all categories", "cookies", "Similar jobs", "Privacy policy", "Sign in to Jobs Example"]) expect(shown).not.toContain(chrome);
    expect(whole).toContain("Accept all cookies");
  }, 60_000);

  it("reads a results list with no <main> without its header and footer, never empty", async () => {
    const { shown } = await read("/results");
    expect(shown).toMatch(/\[Read: (dense|text)\]/);
    for (const job of ["Accountant, Acme Ltd", "Analyst, Beta plc", "Auditor, Gamma LLP"]) expect(shown).toContain(job);
    for (const chrome of ["Browse all categories", "cookies", "Privacy policy"]) expect(shown).not.toContain(chrome);
  }, 60_000);
});
