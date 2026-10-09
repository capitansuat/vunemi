/**
 * The agent's view of the browser: short tab numbers instead of 32-char
 * target ids, a "current tab", and — after every action — a verdict on what
 * actually happened, so the model notices a click that did nothing without
 * spending a step (or a screenshot) to check.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { find, outline } from "@vunemi/perception";
import type { BrowserBackend, TabInfo } from "./backend.js";
import { detectChallenge } from "./challenge.js";
import { PageActionError, PageDriver, type OwnerField, type PointerEvent } from "./page.js";
import type { TrustedSites } from "./url-policy.js";

export interface TabView {
  id: number;
  url: string;
  title: string;
  current: boolean;
}

interface Snapshot {
  url: string;
  refs: Set<number>;
  /** ref → its outline line, for approval previews. */
  lines: Map<number, string>;
}

const DESCRIBE_BUDGET = 16_000; // ≈4K tokens
const VERDICT_LINES = 30;

/** The tab an action opened, if it opened one: the newest that was not there before. */
export function openedTab(before: readonly TabInfo[], after: readonly TabInfo[]): string | null {
  const known = new Set(before.map((t) => t.targetId));
  return after.filter((t) => !known.has(t.targetId)).at(-1)?.targetId ?? null;
}

export class BrowserController {
  private backend: BrowserBackend | null = null;
  private starting: Promise<BrowserBackend> | null = null;
  private readonly shortIds = new Map<string, number>();
  private nextShort = 1;
  private current: string | null = null;
  private readonly drivers = new Map<string, Promise<PageDriver>>();
  private readonly snapshots = new Map<string, Snapshot>();
  /** Bot check seen on the current page by the last goto/act, if any. */
  private seenChallenge: string | null = null;

  private pointerListener: ((target: string, p: PointerEvent) => Promise<void> | void) | null = null;

  /**
   * `trusted` is the user's list of private-network sites the browser may
   * open; see url-policy.
   */
  constructor(
    private readonly connect: () => Promise<BrowserBackend>,
    readonly trusted: () => TrustedSites = () => new Set(),
  ) {}

  /** Lets a UI draw the agent's cursor; see PageDriver.pointer. */
  onPointer(listener: (target: string, p: PointerEvent) => Promise<void> | void): void {
    this.pointerListener = listener;
  }

  get kind(): BrowserBackend["kind"] | null {
    return this.backend?.kind ?? null;
  }

  // -- tabs ----------------------------------------------------------------

  async tabs(): Promise<TabView[]> {
    const b = await this.ensure();
    const list = await b.listTabs();
    for (const t of list) if (!this.shortIds.has(t.targetId)) this.shortIds.set(t.targetId, this.nextShort++);
    for (const id of [...this.shortIds.keys()]) {
      if (!list.some((t) => t.targetId === id)) this.forget(id);
    }
    if (this.current && !this.shortIds.has(this.current)) this.current = null;
    this.current ??= list[0]?.targetId ?? null;
    return list.map((t) => ({
      id: this.shortIds.get(t.targetId)!,
      url: t.url,
      title: t.title,
      current: t.targetId === this.current,
    }));
  }

  /**
   * The user brought a tab forward in Vunemi's browser: opened an offer from
   * a card, say, or picked a tab. The page tools work there next, rather
   * than in the tab the last task left behind, which made the agent open
   * the user's page a second time.
   */
  follow(targetId: string): void {
    if (!this.shortIds.has(targetId)) this.shortIds.set(targetId, this.nextShort++);
    this.current = targetId;
  }

  async focus(tab: number): Promise<TabView> {
    const target = await this.resolveTab(tab);
    await (await this.ensure()).activateTab(target);
    this.current = target;
    return (await this.tabs()).find((t) => t.id === tab)!;
  }

  async closeTab(tab: number): Promise<void> {
    const target = await this.resolveTab(tab);
    await (await this.ensure()).closeTab(target);
    this.forget(target);
    if (this.current === target) this.current = null;
  }

  // -- navigation ----------------------------------------------------------

  async goto(url: string, newTab: boolean): Promise<string> {
    const b = await this.ensure();
    if (newTab || (await this.tabs()).length === 0) {
      const target = await b.openTab("about:blank");
      this.shortIds.set(target, this.nextShort++);
      this.current = target;
    }
    const { driver, target } = await this.page();
    try {
      await driver.navigate(url);
    } catch (err) {
      // The network guard refused it; say why rather than Chromium's error code.
      const why = err instanceof PageActionError && err.message.includes("ERR_BLOCKED_BY_CLIENT") ? b.blockReason?.(target) : null;
      throw why ? new PageActionError(why) : err;
    }
    await driver.settle();
    return this.landing(driver, target);
  }

  async back(): Promise<string> {
    const { driver, target } = await this.page();
    if (!(await driver.back())) return "There is no previous page in this tab's history.";
    await driver.settle();
    return this.landing(driver, target);
  }

  // -- reading -------------------------------------------------------------

  async describe(opts: { ref?: number; interactiveOnly?: boolean } = {}): Promise<string> {
    const { driver, target } = await this.page();
    const [loc, nodes] = await Promise.all([driver.location(), driver.axNodes()]);
    const prev = this.snapshots.get(target);
    const o = outline(nodes, {
      ...(opts.ref !== undefined && { rootRef: opts.ref }),
      ...(prev && prev.url === loc.url && { previousRefs: prev.refs }),
      interactiveOnly: opts.interactiveOnly ?? false,
      maxChars: DESCRIBE_BUDGET,
    });
    if (opts.ref !== undefined && o.text === "") {
      throw new PageActionError(`No element [${opts.ref}] on this page. Call page_describe without a ref to see the page.`);
    }
    // The baseline for "what changed" is always the whole page, whatever
    // slice was shown — otherwise hidden-from-view elements would later
    // count as "appeared".
    if (opts.ref === undefined && !opts.interactiveOnly) {
      this.remember(target, loc.url, o.text, o.refs);
    } else {
      const full = outline(nodes, { maxChars: DESCRIBE_BUDGET });
      this.remember(target, loc.url, full.text, full.refs);
    }
    return `${header(await this.tabNumber(target), loc)}\n${o.text || "(the page has no readable content yet)"}`;
  }

  async find(query: string): Promise<string> {
    const { driver, target } = await this.page();
    const hits = find(await driver.axNodes(), query);
    for (const line of hits) this.rememberLine(target, line);
    return hits.length === 0 ? `Nothing on this page matches "${query}".` : hits.join("\n");
  }

  async read(maxChars: number): Promise<string> {
    const { driver, target } = await this.page();
    const r = await driver.readText(maxChars);
    const more = r.truncated > 0 ? `\n[… ${r.truncated} more characters not read.]` : "";
    return `${header(await this.tabNumber(target), r)}\n${r.text || "(no visible text)"}${more}`;
  }

  /** Saves a picture of the current tab into `dir`; its path and where the tab was. */
  async screenshot(dir: string): Promise<{ path: string; url: string; title: string }> {
    const { driver, target } = await this.page();
    const loc = await driver.location();
    const backend = await this.ensure();
    const image = await driver.screenshot(10_000, backend.capture ? () => backend.capture!(target) : undefined);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `page-${Date.now()}.jpg`);
    writeFileSync(path, image, { mode: 0o600 });
    return { path, ...loc };
  }

  /** The outline line for a ref, as the model last saw it. For approval previews. */
  lineFor(ref: number): string | undefined {
    return this.current ? this.snapshots.get(this.current)?.lines.get(ref) : undefined;
  }

  /** Whether the element is a field only the user fills in (see PageDriver.ownerField); null when it is not, or is gone. */
  async ownerField(ref: number): Promise<OwnerField | null> {
    const { driver } = await this.page();
    return driver.ownerField(ref).catch(() => null);
  }

  // -- acting --------------------------------------------------------------

  /** The bot check the last navigation or action ran into, if any. */
  get challenge(): string | null {
    return this.seenChallenge;
  }

  /** Looks at the current page again, e.g. after the user dealt with a check. */
  async recheck(): Promise<string | null> {
    const { driver } = await this.page();
    await driver.settle();
    const [loc, nodes] = await Promise.all([driver.location(), driver.axNodes()]);
    this.seenChallenge = detectChallenge(loc.url, nodes);
    return this.seenChallenge;
  }

  /** Runs an action and reports what changed. */
  async act(label: string, action: (driver: PageDriver) => Promise<void>): Promise<string> {
    const { driver, target } = await this.page();
    const before = this.snapshots.get(target) ?? (await this.snapshot(driver, target));
    const beforeUrl = (await driver.location()).url;
    const backend = await this.ensure();
    const tabsBefore = await backend.listTabs();

    await action(driver);
    await driver.settle();

    // A link or a form can open its page in a new tab ("Continue to book"
    // does). The old tab then looks unchanged: the model pressed the button
    // again and again, a new tab each time. Go where the action led.
    const opened = openedTab(tabsBefore, await backend.listTabs());
    if (opened) {
      this.follow(opened);
      const next = await this.page();
      await next.driver.settle();
      return `${label}\n→ This opened a new tab, which is now the current tab. ${await this.landing(next.driver, next.target)}`;
    }

    const loc = await driver.location();
    if (loc.url !== beforeUrl) return `${label}\n→ ${await this.landing(driver, target)}`;

    const nodes = await driver.axNodes();
    this.seenChallenge = detectChallenge(loc.url, nodes);
    const full = outline(nodes, { maxChars: DESCRIBE_BUDGET });
    const added = [...full.refs].filter((r) => !before.refs.has(r));
    const removed = [...before.refs].filter((r) => !full.refs.has(r));
    this.remember(target, loc.url, full.text, full.refs);

    if (added.length === 0 && removed.length === 0) {
      return `${label}\n→ No visible change on the page. The action may have had no effect; try a different element, or check with page_describe.`;
    }
    const fresh = outline(nodes, { previousRefs: before.refs, interactiveOnly: true })
      .text.split("\n")
      .filter((l) => l.trimStart().startsWith("*["))
      .map((l) => l.trim());
    const shown = fresh.slice(0, VERDICT_LINES);
    return [
      label,
      `→ The page changed: ${added.length} element(s) appeared, ${removed.length} disappeared.`,
      ...(shown.length > 0 ? ["New interactive elements:", ...shown] : []),
      ...(fresh.length > shown.length ? [`… and ${fresh.length - shown.length} more. Use page_describe to see everything.`] : []),
    ].join("\n");
  }

  async dispose(): Promise<void> {
    this.seenChallenge = null;
    const b = this.backend;
    this.backend = null;
    this.drivers.clear();
    this.snapshots.clear();
    this.shortIds.clear();
    this.current = null;
    await b?.close();
  }

  // -- internals -----------------------------------------------------------

  private async ensure(): Promise<BrowserBackend> {
    if (this.backend?.connected) return this.backend;
    if (this.backend) {
      // The browser went away (user quit it); start clean.
      this.backend = null;
      this.drivers.clear();
      this.snapshots.clear();
      this.shortIds.clear();
      this.current = null;
    }
    this.starting ??= this.connect().finally(() => {
      this.starting = null;
    });
    const b = await this.starting;
    if (this.backend !== b) {
      // A detached tab's driver has lost its enabled domains; re-attach next time.
      b.onDetach((target) => {
        if (this.backend !== b) return;
        this.drivers.delete(target);
      });
      this.backend = b;
    }
    return b;
  }

  private async page(): Promise<{ driver: PageDriver; target: string }> {
    const b = await this.ensure();
    // The tab this run was working in can close underneath it (the user
    // closed it, or the page went away). Its element numbers mean nothing in
    // another tab, so say so instead of acting anywhere else.
    if (this.current && !(await b.listTabs()).some((t) => t.targetId === this.current)) {
      const gone = this.shortIds.get(this.current);
      this.forget(this.current);
      this.current = null;
      throw new PageActionError(
        `The tab you were working in${gone ? ` (tab ${gone})` : ""} has been closed, so nothing was done. Call tabs_list, or open the page again.`,
      );
    }
    if (!this.current) await this.tabs();
    if (!this.current) {
      const target = await b.openTab("about:blank");
      this.shortIds.set(target, this.nextShort++);
      this.current = target;
    }
    const target = this.current;
    let d = this.drivers.get(target);
    if (!d) {
      d = b.attach(target).then(async (s) => {
        const driver = await PageDriver.attach(s);
        driver.pointer = (p) => this.pointerListener?.(target, p);
        return driver;
      });
      this.drivers.set(target, d);
      d.catch(() => this.drivers.delete(target));
    }
    return { driver: await d, target };
  }

  private async landing(driver: PageDriver, target: string): Promise<string> {
    const [loc, nodes] = await Promise.all([driver.location(), driver.axNodes()]);
    this.seenChallenge = detectChallenge(loc.url, nodes);
    const full = outline(nodes, { maxChars: DESCRIBE_BUDGET });
    this.remember(target, loc.url, full.text, full.refs);
    const interactive = outline(nodes, { interactiveOnly: true, maxChars: 6_000 });
    return [
      `Now on: ${header(await this.tabNumber(target), loc)}`,
      "Interactive elements (use page_describe for the full page, page_read for its text):",
      interactive.text || "(none yet — the page may still be loading; try page_wait)",
    ].join("\n");
  }

  private async snapshot(driver: PageDriver, target: string): Promise<Snapshot> {
    const [loc, nodes] = await Promise.all([driver.location(), driver.axNodes()]);
    const o = outline(nodes, { maxChars: DESCRIBE_BUDGET });
    return this.remember(target, loc.url, o.text, o.refs);
  }

  private remember(target: string, url: string, text: string, refs: Set<number>): Snapshot {
    const lines = new Map<number, string>();
    for (const l of text.split("\n")) {
      const m = l.trim().match(/^\*?\[(\d+)\] (.*)$/);
      if (m) lines.set(Number(m[1]), m[2]!);
    }
    const snap = { url, refs, lines };
    this.snapshots.set(target, snap);
    return snap;
  }

  private rememberLine(target: string, line: string): void {
    const m = line.match(/^\[(\d+)\] (.*)$/);
    if (m) this.snapshots.get(target)?.lines.set(Number(m[1]), m[2]!);
  }

  private async resolveTab(tab: number): Promise<string> {
    await this.tabs();
    for (const [target, id] of this.shortIds) if (id === tab) return target;
    throw new PageActionError(`There is no tab ${tab}. Call tabs_list to see open tabs.`);
  }

  private async tabNumber(target: string): Promise<number> {
    if (!this.shortIds.has(target)) await this.tabs();
    return this.shortIds.get(target) ?? 0;
  }

  private forget(target: string): void {
    this.shortIds.delete(target);
    this.drivers.delete(target);
    this.snapshots.delete(target);
  }
}

function header(tab: number, loc: { url: string; title: string }): string {
  return `[tab ${tab}] ${loc.title || "(untitled)"} — ${loc.url}`;
}
