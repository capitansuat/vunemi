/**
 * "Approve all in this task" on a page action covers one site: the page's
 * host. Anything in a form that posts needs its own card.
 */
import { describe, expect, it } from "vitest";
import { approveAllCover } from "@vunemi/agent-core";
import type { BrowserController } from "../src/controller.js";
import { createBrowserTools } from "../src/tools.js";

interface Fake {
  host: string | null;
  live?: string | null;
  kinds?: Record<number, string>;
  focused?: string;
  trusted?: string[];
  /** ref → its outline line, as the model saw it. */
  lines?: Record<number, string>;
  /** The field page_type last typed into, and its kind. */
  typedInto?: number;
}

function tools(f: Fake, opts: { trusted?: () => ReadonlySet<string> } = {}) {
  const browser = {
    kind: "embedded",
    host: () => f.host,
    liveHost: async () => (f.live === undefined ? f.host : f.live),
    kindFor: (ref: number) => f.kinds?.[ref],
    focusedKind: () => (f.typedInto === undefined ? undefined : f.kinds?.[f.typedInto]),
    focusedRef: () => f.typedInto,
    focusedLiveKind: async () => f.focused,
    lineFor: (ref: number) => f.lines?.[ref],
    trusted: () => new Set(f.trusted ?? []),
  } as unknown as BrowserController;
  const list = createBrowserTools(browser, opts);
  return (name: string) => list.find((t) => t.name === name)!;
}

const kinds = { 1: "link", 2: "search", 3: "posts", 4: "other" };

describe("approve all covers the page's site", () => {
  it("keys a click, typing, a choice and a key press by the host", async () => {
    const tool = tools({ host: "example.com", kinds, focused: "other" });
    const site = { key: "site:example.com", site: "example.com", trusted: false };
    expect(await approveAllCover(tool("page_click"), { ref: 4 })).toEqual(site);
    expect(await approveAllCover(tool("page_click"), { ref: 1 })).toEqual(site);
    expect(await approveAllCover(tool("page_type"), { ref: 4, text: "x", submit: true })).toEqual(site);
    expect(await approveAllCover(tool("page_type"), { ref: 2, text: "x" })).toEqual(site);
    expect(await approveAllCover(tool("page_select"), { ref: 4, option: "Blue" })).toEqual(site);
    expect(await approveAllCover(tool("page_press"), { key: "Enter" })).toEqual(site);
    expect(await approveAllCover(tool("page_press"), { key: "Tab" })).toEqual(site);
  });

  it("gives each host its own key: another site and a lookalike are not covered", async () => {
    const a = await approveAllCover(tools({ host: "example.com", kinds })("page_click"), { ref: 4 });
    const b = await approveAllCover(tools({ host: "shop.example", kinds })("page_click"), { ref: 4 });
    const c = await approveAllCover(tools({ host: "evil.example.com.attacker.net", kinds })("page_click"), { ref: 4 });
    const d = await approveAllCover(tools({ host: "www.example.com", kinds })("page_click"), { ref: 4 });
    expect(new Set([a?.key, b?.key, c?.key, d?.key]).size).toBe(4);
    expect(b?.key).toBe("site:shop.example");
    expect(c?.key).toBe("site:evil.example.com.attacker.net");
  });

  it("covers nothing in a form that posts, for a ref nobody saw, or with no page", async () => {
    const tool = tools({ host: "example.com", kinds });
    expect(await approveAllCover(tool("page_click"), { ref: 3 })).toBeUndefined();
    expect(await approveAllCover(tool("page_type"), { ref: 3, text: "hello", submit: true })).toBeUndefined();
    expect(await approveAllCover(tool("page_type"), { ref: 3, text: "hello" })).toBeUndefined();
    expect(await approveAllCover(tool("page_select"), { ref: 3, option: "All" })).toBeUndefined();
    expect(await approveAllCover(tool("page_click"), { ref: 99 })).toBeUndefined();
    expect(await approveAllCover(tools({ host: null, kinds })("page_click"), { ref: 4 })).toBeUndefined();
  });

  it("covers nothing for Enter or Space in a field that posts, or where the focus can't be seen", async () => {
    for (const focused of ["posts", undefined]) {
      const tool = tools({ host: "example.com", kinds, ...(focused && { focused }) });
      expect(await approveAllCover(tool("page_press"), { key: "Enter" })).toBeUndefined();
      expect(await approveAllCover(tool("page_press"), { key: "Space" })).toBeUndefined();
      expect(await approveAllCover(tool("page_press"), { key: "ArrowDown" })).toBeDefined();
    }
  });

  it("covers nothing once the page has moved to another host than the one the model saw", async () => {
    const tool = tools({ host: "example.com", live: "shop.example", kinds });
    expect(await approveAllCover(tool("page_click"), { ref: 4 })).toBeUndefined();
  });

  it("says whether the user trusts the site, from the user's own list", async () => {
    const listed = () => new Set(["example.com"]);
    expect(await approveAllCover(tools({ host: "example.com", kinds }, { trusted: listed })("page_click"), { ref: 4 })).toMatchObject({ trusted: true });
    expect(await approveAllCover(tools({ host: "shop.example", kinds }, { trusted: listed })("page_click"), { ref: 4 })).toMatchObject({ trusted: false });
    // Without the option, the browser's own list is the one.
    expect(await approveAllCover(tools({ host: "example.com", kinds, trusted: ["example.com"] })("page_click"), { ref: 4 })).toMatchObject({ trusted: true });
  });

  it("keeps its own card for a control that sends or deletes, also on a trusted site", async () => {
    const lines = { 4: 'button "Delete account"', 1: 'link "Send a message"', 2: 'searchbox "Reply"', 5: 'button "Sil"', 6: 'button "Apply filters"' };
    const all = { ...kinds, 5: "other", 6: "other" };
    for (const trusted of [[], ["example.com"]]) {
      const tool = tools({ host: "example.com", kinds: all, lines, trusted, focused: "other" });
      expect(await approveAllCover(tool("page_click"), { ref: 4 })).toBeUndefined();
      expect(await approveAllCover(tool("page_click"), { ref: 1 })).toBeUndefined();
      expect(await approveAllCover(tool("page_click"), { ref: 5 })).toBeUndefined();
      expect(await approveAllCover(tool("page_type"), { ref: 2, text: "ok", submit: true })).toBeUndefined();
      expect(await approveAllCover(tool("page_press"), { key: "Delete" })).toBeUndefined();
      expect(await approveAllCover(tool("page_press"), { key: "Backspace" })).toBeUndefined();
      expect(await approveAllCover(tool("page_click"), { ref: 6 })).toBeDefined();
    }
  });

  it("asks for a link or a search box that sounds like sending or deleting, instead of reading", () => {
    const tool = tools({ host: "example.com", kinds: { 1: "link", 2: "search", 7: "link" }, lines: { 1: 'link "Unsubscribe and delete"', 2: 'searchbox "Post a comment"', 7: 'link "Software developer, Leeds"' } });
    expect(tool("page_click").classify!({ ref: 1 })).toBe("outbound");
    expect(tool("page_type").classify!({ ref: 2, text: "x" })).toBe("outbound");
    expect(tool("page_click").classify!({ ref: 7 })).toBe("read");
  });

  it("asks for Enter in a field whose label sounds like sending, and covers it for none", async () => {
    const tool = tools({ host: "example.com", kinds: { 2: "search", 8: "search" }, lines: { 2: 'searchbox "Reply to all"', 8: 'searchbox "Search jobs"' }, typedInto: 2, focused: "search" });
    expect(tool("page_press").classify!({ key: "Enter" })).toBe("outbound");
    expect(await approveAllCover(tool("page_press"), { key: "Enter" })).toBeUndefined();
    const plain = tools({ host: "example.com", kinds: { 8: "search" }, lines: { 8: 'searchbox "Search jobs"' }, typedInto: 8, focused: "search" });
    expect(plain("page_press").classify!({ key: "Enter" })).toBe("read");
  });

  it("leaves every other page tool to its own card", async () => {
    const tool = tools({ host: "example.com", kinds });
    for (const name of ["page_target_act", "tabs_close", "page_goto", "user_takeover"]) expect(tool(name).approveAll).toBeUndefined();
  });
});
