/**
 * What kind of element the model acts on: an ordinary link, a search field
 * in a form that sends its query in the address (GET), something in a form
 * that posts, or anything else. Read from the page's own elements when the
 * outline is made, never from the model's words.
 */
import { describe, expect, it, vi } from "vitest";
import type { BrowserBackend } from "../src/backend.js";
import type { CdpSession } from "../src/cdp.js";
import { BrowserController } from "../src/controller.js";
import { elementKind, type ElementFacts } from "../src/page.js";
import { createBrowserTools } from "../src/tools.js";
import { checkNavigation, requestGuard } from "../src/url-policy.js";

const GET = { method: "get" };
const NO_METHOD = { method: null };
const POST = { method: "post" };

describe("the kind of an element, from what the page says about it", () => {
  it.each<[string, ElementFacts, string]>([
    ["an http link", { tag: "a", href: "http://example.com/a" }, "link"],
    ["an https link", { tag: "a", href: "https://example.com/a", role: "link" }, "link"],
    ["an image-map area", { tag: "area", href: "https://example.com/a" }, "link"],
    ["a javascript: link", { tag: "a", href: "javascript:void(0)" }, "other"],
    ["a # link", { tag: "a", href: "https://example.com/page#", fragment: true }, "other"],
    ["a link to a place on the same page", { tag: "a", href: "https://example.com/page#top", fragment: true }, "other"],
    ["a mailto: link", { tag: "a", href: "mailto:someone@example.com" }, "other"],
    ["a download link", { tag: "a", href: "https://example.com/file.zip", download: true }, "other"],
    ["a link with a click handler", { tag: "a", href: "https://example.com/a", clickHandler: true }, "other"],
    ["a link made to act as a button", { tag: "a", href: "https://example.com/a", role: "button" }, "other"],
    ["an anchor with no address", { tag: "a" }, "other"],
    ["a link inside a form that posts", { tag: "a", href: "https://example.com/a", form: POST }, "posts"],
    ["a link inside a search form", { tag: "a", href: "https://example.com/help", form: GET }, "link"],
  ])("%s", (_what, facts, kind) => expect(elementKind(facts)).toBe(kind));

  it.each<[string, ElementFacts, string]>([
    ["a text field in a form with no method (GET)", { tag: "input", inputType: "text", form: NO_METHOD }, "search"],
    ["a search field in a GET form", { tag: "input", inputType: "search", form: GET }, "search"],
    ["a text area in a GET form", { tag: "textarea", form: { method: "GET" } }, "search"],
    ["a searchbox in a GET form", { tag: "div", role: "searchbox", contentEditable: true, form: GET }, "search"],
    ["an unknown method, which is GET", { tag: "input", inputType: "text", form: { method: "fetch" } }, "search"],
    ["a text field in a form that posts", { tag: "input", inputType: "text", form: POST }, "posts"],
    ["a text field in a form that POSTs (upper case)", { tag: "input", inputType: "search", form: { method: "POST" } }, "posts"],
    ["a text field whose form's default button posts", { tag: "input", inputType: "search", form: { method: "get", defaultMethod: "post" } }, "posts"],
    ["a text field in a dialog form", { tag: "input", inputType: "text", form: { method: "dialog" } }, "other"],
    ["a text field in a form whose action is script", { tag: "input", inputType: "text", form: { method: "get", action: " javascript:send()" } }, "other"],
    ["a text field with no form", { tag: "input", inputType: "text" }, "other"],
    ["a searchbox with no form", { tag: "input", inputType: "search", role: "searchbox" }, "other"],
    ["a checkbox in a GET form", { tag: "input", inputType: "checkbox", form: GET }, "other"],
    ["an e-mail field in a GET form", { tag: "input", inputType: "email", form: GET }, "other"],
  ])("%s", (_what, facts, kind) => expect(elementKind(facts)).toBe(kind));

  it.each<[string, ElementFacts, string]>([
    ["a submit button in a form that posts", { tag: "button", submits: true, form: POST }, "posts"],
    ["a button with no type in a form that posts", { tag: "button", submits: true, form: { method: "Post" } }, "posts"],
    ["a plain button in a form that posts", { tag: "button", form: POST }, "posts"],
    ["a select in a form that posts", { tag: "select", form: POST }, "posts"],
    ["a submit button that posts a GET form", { tag: "button", submits: true, formMethod: "post", form: GET }, "posts"],
    ["a submit button that GETs a form that posts", { tag: "input", inputType: "submit", submits: true, formMethod: "get", form: POST }, "posts"],
    ["the submit button of a search form", { tag: "button", submits: true, form: GET }, "other"],
    ["a button with no form", { tag: "button" }, "other"],
    ["a div", { tag: "div" }, "other"],
  ])("%s", (_what, facts, kind) => expect(elementKind(facts)).toBe(kind));

  it("knows nothing about nothing", () => {
    expect(elementKind(null)).toBe("other");
  });
});

/** A browser whose kinds are given, for the tools' classifiers. */
function fake(kinds: Record<number, string>, focused?: number): BrowserController {
  return {
    kind: "embedded",
    kindFor: (ref: number) => kinds[ref],
    focusedKind: () => (focused === undefined ? undefined : kinds[focused]),
    lineFor: () => undefined,
    trusted: () => new Set<string>(),
  } as unknown as BrowserController;
}

const toolOf = (browser: BrowserController, name: string) => createBrowserTools(browser).find((t) => t.name === name)!;

describe("what a call on the page is", () => {
  const kinds = { 1: "link", 2: "search", 3: "posts", 4: "other" };

  it("clicking an ordinary link is reading; anything else, or a ref nobody saw, is outbound", () => {
    const click = toolOf(fake(kinds), "page_click");
    expect(click.classify!({ ref: 1 })).toBe("read");
    expect(click.classify!({ ref: "[1]" })).toBe("read");
    for (const ref of [2, 3, 4, 99, "x"]) expect(click.classify!({ ref })).toBe("outbound");
  });

  it("typing into a GET search field is reading, with or without Enter", () => {
    const type = toolOf(fake(kinds), "page_type");
    expect(type.classify!({ ref: 2, text: "weather" })).toBe("read");
    expect(type.classify!({ ref: 2, text: "weather", submit: true })).toBe("read");
    for (const ref of [1, 3, 4, 99]) expect(type.classify!({ ref, text: "x", submit: true })).toBe("outbound");
  });

  it("Enter in the search field just typed into is reading; any other key, or Enter elsewhere, is outbound", () => {
    expect(toolOf(fake(kinds, 2), "page_press").classify!({ key: "Enter" })).toBe("read");
    expect(toolOf(fake(kinds, 2), "page_press").classify!({ key: "Tab" })).toBe("outbound");
    expect(toolOf(fake(kinds, 3), "page_press").classify!({ key: "Enter" })).toBe("outbound");
    expect(toolOf(fake(kinds, 4), "page_press").classify!({ key: "Enter" })).toBe("outbound");
    expect(toolOf(fake(kinds), "page_press").classify!({ key: "Enter" })).toBe("outbound");
  });

  it("choosing an option is never reading", () => {
    const select = toolOf(fake(kinds), "page_select");
    expect(select.classify?.({ ref: 2, option: "x" }) ?? select.actionClass).toBe("outbound");
  });
});

// -- a page read through a fake CDP session --------------------------------

interface Page {
  url: string;
  /** ref → its name in the outline, its role, and what the page says about it. */
  elements: Record<number, { role: string; name: string; facts: ElementFacts; listener?: boolean }>;
  focused?: number;
}

/** One tab whose CDP session answers from `page`; `page` can change between calls. */
function pageBackend(page: Page) {
  const sent: string[] = [];
  const session = {
    on: () => () => undefined,
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      sent.push(method);
      switch (method) {
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "main", url: page.url } } };
        case "Accessibility.getFullAXTree": {
          const refs = Object.keys(page.elements).map(Number);
          return {
            nodes: [
              { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: refs.map(String), backendDOMNodeId: 1 },
              ...refs.map((ref) => ({
                nodeId: String(ref),
                parentId: "root",
                role: { value: page.elements[ref]!.role },
                name: { value: page.elements[ref]!.name },
                backendDOMNodeId: ref,
              })),
            ],
          };
        }
        case "Runtime.evaluate": {
          const expression = String(params.expression ?? "");
          if (expression.includes("location.href")) return { result: { value: { url: page.url, title: "Page" } } };
          if (expression.includes("activeElement")) {
            const el = page.focused === undefined ? null : page.elements[page.focused];
            return { result: { value: el ? el.facts : { tag: "body" } } };
          }
          return { result: { value: null } };
        }
        case "DOM.resolveNode": {
          const ref = Number(params.backendNodeId);
          if (!page.elements[ref]) throw new Error("No node with given id found");
          return { object: { objectId: `obj-${ref}` } };
        }
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          const ids = (params.arguments as { objectId?: string; value?: unknown }[] | undefined) ?? [];
          if (fn.includes("vunemi:element-facts")) {
            return { result: { value: ids.map((a) => page.elements[Number(String(a.objectId).slice(4))]?.facts ?? null) } };
          }
          if (fn.includes("activeElement")) {
            const ref = Number(String(params.objectId).slice(4));
            return { result: { value: page.focused === ref } };
          }
          return { result: { value: null } };
        }
        case "DOMDebugger.getEventListeners": {
          const ref = Number(String(params.objectId).slice(4));
          return { listeners: page.elements[ref]?.listener ? [{ type: "click" }] : [] };
        }
        default:
          return {};
      }
    }),
  } as unknown as CdpSession;
  const backend: BrowserBackend = {
    kind: "embedded",
    connected: true,
    listTabs: async () => [{ targetId: "t1", url: page.url, title: "Page" }],
    openTab: async () => "t1",
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    attach: async () => session,
    onDetach: () => () => undefined,
    close: async () => undefined,
  };
  return { backend, sent };
}

describe("the browser remembers each element's kind when it reads the page", () => {
  const page = (): Page => ({
    url: "https://Example.COM./start",
    elements: {
      11: { role: "link", name: "Docs", facts: { tag: "a", href: "https://example.com/docs" } },
      12: { role: "searchbox", name: "Search", facts: { tag: "input", inputType: "search", form: { method: null } } },
      13: { role: "button", name: "Send", facts: { tag: "button", submits: true, form: { method: "post" } } },
      14: { role: "link", name: "Buy", facts: { tag: "a", href: "https://example.com/buy" }, listener: true },
      15: { role: "link", name: "Router", facts: { tag: "a", href: "http://192.168.1.10/" } },
    },
  });

  it("reads them in one pass over the outline's elements, and answers without asking the page again", async () => {
    const p = page();
    const { backend, sent } = pageBackend(p);
    const browser = new BrowserController(async () => backend);
    expect(browser.kindFor(11)).toBeUndefined();
    expect(browser.host()).toBeNull();
    await browser.describe();
    expect(sent.filter((m) => m === "Runtime.callFunctionOn")).toHaveLength(1);
    const before = sent.length;
    expect(browser.kindFor(11)).toBe("link");
    expect(browser.kindFor(12)).toBe("search");
    expect(browser.kindFor(13)).toBe("posts");
    // A listener on the link itself may do anything when it is clicked.
    expect(browser.kindFor(14)).toBe("other");
    expect(browser.kindFor(99)).toBeUndefined();
    expect(browser.host()).toBe("example.com");
    expect(sent.length).toBe(before);
  });

  it("a link to a private-network address is refused before any card, as page_goto refuses it", async () => {
    const p = page();
    const { backend } = pageBackend(p);
    const browser = new BrowserController(async () => backend);
    await browser.describe();
    const click = createBrowserTools(browser).find((t) => t.name === "page_click")!;
    expect(click.classify!({ ref: 15 })).toBe("read");
    const why = await click.check!({ ref: 15 });
    expect(why).toBe(checkNavigation("http://192.168.1.10/"));
    expect(why).toMatch(/192\.168\.1\.10 is on a private network/);
    expect(await click.check!({ ref: 11 })).toBeNull();
    // Whatever opens a page, the network guard refuses the same address for the page itself.
    const guard = requestGuard(async () => []);
    expect(await guard("http://192.168.1.10/")).toBe(why);
  });

  it("refuses a call judged by what is no longer there: an element that changed, or a page that moved to another site", async () => {
    const p = page();
    const { backend } = pageBackend(p);
    const browser = new BrowserController(async () => backend);
    await browser.describe();
    const click = createBrowserTools(browser).find((t) => t.name === "page_click")!;
    // The link became a button that posts.
    p.elements[11]!.facts = { tag: "button", submits: true, form: { method: "post" } };
    expect(await click.check!({ ref: 11 })).toMatch(/changed since the page was read.*Nothing was done/s);
    // Judged again by what it is now.
    expect(click.classify!({ ref: 11 })).toBe("outbound");
    expect(browser.kindFor(11)).toBe("posts");
    // A ref nobody saw is left to the action's own error.
    expect(await click.check!({ ref: 99 })).toBeNull();
    p.url = "https://shop.example/";
    expect(await click.check!({ ref: 12 })).toMatch(/shop\.example.*Nothing was done/s);
  });

  it("Enter counts as a search only while the focus is still in the search field typed into", async () => {
    const p = page();
    const { backend } = pageBackend(p);
    const browser = new BrowserController(async () => backend);
    await browser.describe();
    expect(browser.focusedKind()).toBeUndefined();
    browser.noteFocus(12);
    expect(browser.focusedKind()).toBe("search");
    const press = createBrowserTools(browser).find((t) => t.name === "page_press")!;
    expect(press.classify!({ key: "Enter" })).toBe("read");
    p.focused = 12;
    expect(await press.check!({ key: "Enter" })).toBeNull();
    p.focused = 13;
    expect(await press.check!({ key: "Enter" })).toMatch(/focus.*Nothing was done/s);
    expect(browser.focusedKind()).toBeUndefined();
    // Any other action moves the focus where Vunemi can't follow it.
    browser.noteFocus(12);
    await browser.act("Clicked.", async () => undefined);
    expect(browser.focusedKind()).toBeUndefined();
  });
});
