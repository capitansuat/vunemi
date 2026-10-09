/**
 * Fields only the user fills in, in a real headless Chrome. Skipped unless
 * VUNEMI_LIVE_BROWSER=1, since it launches a browser.
 *
 * The fixtures are the shapes such forms come in: a sign-in form, a sign-in
 * with no form around it, the first step of a two-step sign-in, and a
 * passenger form that declares nothing and is known only by its labels.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../src/controller.js";
import { launchIsolatedChrome } from "../src/chrome.js";
import { createBrowserTools } from "../src/tools.js";

const PAGES: Record<string, string> = {
  "/signin": `<title>Sign in</title>
    <header><input type="search" aria-label="Site search"></header>
    <form><input aria-label="Account" name="acct"><input type="password" aria-label="Secret"><input aria-label="Coupon in the form"></form>
    <input aria-label="Newsletter topic">`,
  "/bare": `<title>Bare sign in</title>
    <input role="searchbox" aria-label="Find a product">
    <input aria-label="Member number">
    <input type="password" aria-label="Secret">`,
  "/first-step": `<title>First step</title>
    <input type="text" autocomplete="username" aria-label="Your account">
    <input autocomplete="one-time-code" aria-label="Code we sent">`,
  "/passenger": `<title>Passenger</title>
    <input name="passenger0FirstName" aria-label="Given">
    <label>Surname <input name="p0s"></label>
    <label>Date of birth <input name="p0d"></label>
    <input placeholder="Pasaport numarası">
    <input aria-label="E-posta adresiniz">
    <input type="email" aria-label="Contact">
    <input aria-label="Cep telefonu">
    <input autocomplete="address-line1" aria-label="Line one">
    <select autocomplete="honorific-prefix" aria-label="Title"><option>Mr</option><option>Ms</option></select>
    <select aria-label="Doğum yılı"><option>1990</option><option>1991</option></select>
    <label>Customer name: <input name="custname"></label>
    <form><label>Name * <input name="n"></label><input type="tel" aria-label="Reach me on"><label>Town <input name="city"></label><label>ZIP <input name="z"></label></form>`,
  "/open": `<title>Open</title>
    <input aria-label="From city">
    <input aria-label="Search by name or email">
    <input type="search" name="email-search" aria-label="Mail">
    <textarea aria-label="Message"></textarea>
    <input aria-label="Playlist name">
    <input autocomplete="postal-code" aria-label="Store near">
    <select aria-label="Cabin class"><option>Economy</option><option>Business</option></select>
    <form><label>Name <input name="list"></label><textarea aria-label="What it is for"></textarea><label>Leaving from <input name="city"></label><label>Street <input name="st"></label></form>`,
};

const live = process.env.VUNEMI_LIVE_BROWSER === "1";

describe.skipIf(!live)("fields only the user fills in, in live Chrome", () => {
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
    profile = mkdtempSync(join(tmpdir(), "vunemi-owner-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
  }, 60_000);

  afterAll(async () => {
    await browser?.dispose();
    server?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  /** What each named field of a page is taken for. */
  const kinds = async (path: string, names: string[]): Promise<Record<string, string | null>> => {
    await browser.goto(base + path, false);
    const text = await browser.describe();
    const out: Record<string, string | null> = {};
    for (const name of names) {
      const line = text.split("\n").find((l) => l.includes(`"${name}"`) && /\[\d+\]/.test(l));
      if (!line) throw new Error(`No element named ${name} in:\n${text}`);
      out[name] = await browser.ownerField(Number(line.match(/\[(\d+)\]/)![1]));
    }
    return out;
  };

  it("takes every field of a sign-in form for the user's, and leaves the page's other fields alone", { timeout: 60_000 }, async () => {
    expect(await kinds("/signin", ["Site search", "Account", "Secret", "Coupon in the form", "Newsletter topic"])).toEqual({
      "Site search": null, Account: "sign-in", Secret: "password", "Coupon in the form": "sign-in", "Newsletter topic": null,
    });
    // With no form around it, the text field beside the password is the account's; a search box is not.
    expect(await kinds("/bare", ["Find a product", "Member number", "Secret"])).toEqual({ "Find a product": null, "Member number": "sign-in", Secret: "password" });
    expect(await kinds("/first-step", ["Your account", "Code we sent"])).toEqual({ "Your account": "sign-in", "Code we sent": "code" });
  });

  it("knows a passenger form by what it declares and by how its fields are named", { timeout: 60_000 }, async () => {
    const got = await kinds("/passenger", ["Given", "Surname", "Date of birth", "Pasaport numarası", "E-posta adresiniz", "Contact", "Cep telefonu", "Line one", "Title", "Doğum yılı", "Customer name:", "Name *", "Reach me on", "Town", "ZIP"]);
    expect(Object.values(got).every((kind) => kind === "personal"), JSON.stringify(got)).toBe(true);
  });

  it("leaves a search, a message and a route alone", { timeout: 60_000 }, async () => {
    const got = await kinds("/open", ["From city", "Search by name or email", "Mail", "Message", "Playlist name", "Store near", "Cabin class", "Name", "What it is for", "Leaving from", "Street"]);
    expect(Object.values(got).every((kind) => kind === null), JSON.stringify(got)).toBe(true);
  });

  it("refuses the typing and the choosing, before any card and in the driver too", { timeout: 60_000 }, async () => {
    await browser.goto(`${base}/passenger`, false);
    const text = await browser.describe();
    const ref = (name: string) => Number(text.split("\n").find((l) => l.includes(`"${name}"`))!.match(/\[(\d+)\]/)![1]);
    const tools = createBrowserTools(browser);
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    expect(await tool("page_type").check!({ ref: ref("Surname"), text: "Yılmaz" })).toMatch(/personal details.*user_takeover/s);
    expect(await tool("page_select").check!({ ref: `[${ref("Title")}]`, option: "Ms" })).toMatch(/user_takeover/);
    const typed = await browser.act("typed", (d) => d.type(ref("Surname"), "Yılmaz")).catch((e: unknown) => e);
    expect(String((typed as Error).message)).toMatch(/personal details/);
    const chosen = await browser.act("chosen", async (d) => void (await d.select(ref("Title"), "Ms"))).catch((e: unknown) => e);
    expect(String((chosen as Error).message)).toMatch(/personal details/);
    await browser.goto(`${base}/open`, false);
    const open = await browser.describe();
    const city = Number(open.split("\n").find((l) => l.includes('"From city"'))!.match(/\[(\d+)\]/)![1]);
    expect(await tool("page_type").check!({ ref: city, text: "Izmir" })).toBeNull();
    await browser.act("typed", (d) => d.type(city, "Izmir"));
  });
});
