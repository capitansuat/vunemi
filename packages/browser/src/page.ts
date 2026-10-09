/**
 * Everything the agent does to a page, written once against a CDP session.
 *
 * Elements are addressed by `backendDOMNodeId` — the refs that the outline
 * prints — and clicks are real compositor-level mouse events at the
 * element's on-screen centre, so they behave like a person's click.
 *
 * `Runtime.enable` is deliberately never called: sites use its side effects
 * to detect automation, and `Runtime.evaluate` works without it.
 */

import type { AXNode } from "@vunemi/perception";
import type { CdpSession } from "./cdp.js";
import { closedFrame } from "./frames.js";

/** Thrown for failures the model should read and route around. */
export class PageActionError extends Error {
  override name = "PageActionError";
}

/** Where the agent is about to act, for drawing its cursor. Coordinates are viewport CSS px. */
export type PointerEvent =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; x: number; y: number; text: string }
  | { kind: "key"; key: string };

/** How deep frames inside frames are followed. */
const MAX_FRAME_DEPTH = 4;

// Where the password, card and one-time-code fields are drawn: in the
// document and in every frame of it that it can reach (same origin), since a
// sign-in form often lives in an iframe. Each is [left, top, width, height].
const SENSITIVE_RECTS = `(() => {
  const sensitive = 'input[type=password], [autocomplete^="cc-"], [autocomplete="one-time-code"], [autocomplete="current-password"], [autocomplete="new-password"]';
  const out = [];
  const visit = (doc, dx, dy, depth) => {
    for (const el of doc.querySelectorAll(sensitive)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push([dx + r.left, dy + r.top, r.width, r.height]);
    }
    if (depth >= ${MAX_FRAME_DEPTH}) return;
    for (const f of doc.querySelectorAll("iframe, frame")) {
      let inner = null;
      try { inner = f.contentDocument; } catch (e) {}
      if (!inner) continue;
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      visit(inner, dx + r.left + f.clientLeft + parseFloat(cs.paddingLeft), dy + r.top + f.clientTop + parseFloat(cs.paddingTop), depth + 1);
    }
  };
  visit(document, 0, 0, 0);
  return out;
})()`;

/**
 * Covers them with black boxes that nothing can click. The boxes go on the
 * top page, over where each field is drawn, so a frame's own scripts never
 * see them.
 */
const maskScript = (rects: number[][]): string => `(() => {
  for (const [x, y, w, h] of ${JSON.stringify(rects)}) {
    const box = document.createElement("div");
    box.setAttribute("data-vunemi-mask", "");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#000;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px";
    document.documentElement.appendChild(box);
  }
  return true;
})()`;
const UNMASK_SENSITIVE = `(() => { for (const el of document.querySelectorAll("[data-vunemi-mask]")) el.remove(); return true; })()`;

export class PageDriver {
  /**
   * Called just before each input, and awaited, so a UI can show the agent's
   * cursor arriving before the click lands. Optional; failures are ignored.
   */
  pointer: ((p: PointerEvent) => Promise<void> | void) | null = null;
  private mainFrameId: string | null = null;
  private loading = false;
  private readonly loadWaiters = new Set<() => void>();
  /** The frames from other sites on the page, by the id of their session. */
  private readonly outer = new Map<string, OuterFrame>();
  /** The refs given to elements in those frames: their own node ids restart in every process. */
  private readonly frameRefs = new Map<number, { frame: OuterFrame; node: number }>();
  private readonly frameRefIds = new Map<string, number>();
  private nextFrameRef = FRAME_REF_BASE;
  /** The page's own refs when it was last read: a ref into a frame is never one of them. */
  private pageRefs: ReadonlyMap<number, unknown> = new Map();

  private constructor(private readonly s: CdpSession) {}

  static async attach(session: CdpSession): Promise<PageDriver> {
    const d = new PageDriver(session);
    session.on("Page.frameStartedLoading", (p) => {
      if ((p as { frameId: string }).frameId === d.mainFrameId) d.loading = true;
    });
    session.on("Page.loadEventFired", () => {
      d.loading = false;
      for (const w of d.loadWaiters) w();
      d.loadWaiters.clear();
    });
    await Promise.all([session.send("Page.enable"), session.send("Accessibility.enable")]);
    const { frameTree } = await session.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    d.mainFrameId = frameTree.frame.id;
    await d.watch(session, null);
    return d;
  }

  /**
   * Follows the frames from other sites under a session. Each runs in a
   * process of its own and gets a session of its own, and may hold more of
   * them. Where the host cannot hand out such sessions, nothing is followed.
   */
  private async watch(s: CdpSession, parent: OuterFrame | null): Promise<void> {
    if (!s.child) return;
    const attached = s.on("Target.attachedToTarget", (p) => {
      const { sessionId, targetInfo } = p as { sessionId: string; targetInfo: { targetId: string; type: string } };
      if (targetInfo.type !== "iframe") return;
      const frame: OuterFrame = { id: targetInfo.targetId, s: s.child!(sessionId), parent, off: [] };
      this.outer.set(sessionId, frame);
      void this.watch(frame.s, frame);
    });
    const detached = s.on("Target.detachedFromTarget", (p) => {
      const gone = this.outer.get((p as { sessionId: string }).sessionId);
      if (gone) this.forget(gone);
    });
    parent?.off.push(attached, detached);
    await s.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
  }

  /** A frame that left the page, with the frames in it and the refs into them. */
  private forget(gone: OuterFrame): void {
    const within = (f: OuterFrame | null): boolean => f !== null && (f === gone || within(f.parent));
    for (const [id, frame] of this.outer) {
      if (!within(frame)) continue;
      this.outer.delete(id);
      for (const off of frame.off.splice(0)) off();
    }
    for (const [ref, at] of this.frameRefs) {
      if (!within(at.frame)) continue;
      this.frameRefs.delete(ref);
      this.frameRefIds.delete(`${at.frame.id}:${at.node}`);
    }
  }

  /** The ref of a node in a frame from another site: the same one every time it is seen. */
  private refFor(frame: OuterFrame, node: number): number {
    const key = `${frame.id}:${node}`;
    let ref = this.frameRefIds.get(key);
    if (ref === undefined) {
      while (this.pageRefs.has(this.nextFrameRef)) this.nextFrameRef++;
      ref = this.nextFrameRef++;
      this.frameRefIds.set(key, ref);
      this.frameRefs.set(ref, { frame, node });
    }
    return ref;
  }

  /** The session a ref's element lives in, and its node id there. */
  private at(ref: number): { s: CdpSession; node: number; frame: OuterFrame | null } {
    const inner = this.frameRefs.get(ref);
    return inner ? { s: inner.frame.s, node: inner.node, frame: inner.frame } : { s: this.s, node: ref, frame: null };
  }

  /** The <iframe> element a frame from another site is shown in, in the document around it. */
  private owner(frame: OuterFrame): Promise<number | null> {
    return (frame.parent?.s ?? this.s)
      .send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: frame.id })
      .then((r) => r.backendNodeId, () => null);
  }

  /** Whether a frame is one the agent does not read (see frames.ts). One that cannot say where it is from is not read either. */
  private closed(frame: OuterFrame): Promise<boolean> {
    return frame.s
      .send<{ frameTree: { frame: { url: string } } }>("Page.getFrameTree")
      .then((r) => closedFrame(r.frameTree.frame.url) !== null, () => true);
  }

  /**
   * Where a frame from another site is drawn. A frame reports positions from
   * its own top left corner; the page's clicks need them from the page's. One
   * entry per frame on the way in, outermost first: the <iframe> element, the
   * session of the document it is in, and where its content starts on the page.
   */
  private async place(frame: OuterFrame): Promise<{ s: CdpSession; owner: number; x: number; y: number }[]> {
    const chain: OuterFrame[] = [];
    for (let f: OuterFrame | null = frame; f; f = f.parent) chain.unshift(f);
    const levels: { s: CdpSession; owner: number; x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    for (const f of chain) {
      const s = f.parent?.s ?? this.s;
      const owner = await this.owner(f);
      const content = owner === null ? null : await s
        .send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: owner })
        .then((r) => r.model.content, () => null);
      if (owner === null || !content || area(content) <= 1) throw new PageActionError("That frame is not shown on the page now. Call page_describe to get fresh refs.");
      x += Math.min(content[0]!, content[2]!, content[4]!, content[6]!);
      y += Math.min(content[1]!, content[3]!, content[5]!, content[7]!);
      levels.push({ s, owner, x, y });
    }
    return levels;
  }

  // -- reading -------------------------------------------------------------

  async location(): Promise<{ url: string; title: string }> {
    return this.evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })");
  }

  /**
   * The page's accessibility tree, with the tree of each frame in it hung
   * under its <iframe>. Chromium hands out one frame's tree at a time, and
   * many sites keep what matters in a frame: PeopleSoft draws its menu and
   * every classic page in one. A frame the page doesn't show has no place in
   * the tree and is left out.
   *
   * A frame from another site (a consent banner, an embedded form, a payment
   * widget) runs in a process of its own. Its tree comes through its own
   * session, and its elements get refs of the driver's making, since node
   * ids are only unique within a process.
   */
  async axNodes(): Promise<AXNode[]> {
    const budget = { frames: MAX_FRAMES };
    const page = await this.tree(this.s, budget);
    this.pageRefs = page.byRef;
    // A page that has made enough nodes to reach a ref given to a frame's element takes it back.
    for (const ref of page.byRef.keys()) {
      const taken = this.frameRefs.get(ref);
      if (!taken) continue;
      this.frameRefs.delete(ref);
      this.frameRefIds.delete(`${taken.frame.id}:${taken.node}`);
    }
    const seen = new Set<number>();
    const hang = async (parent: OuterFrame | null, into: Map<number, AXNode>, depth: number): Promise<void> => {
      if (depth > MAX_FRAME_DEPTH) return;
      for (const frame of [...this.outer.values()]) {
        if (frame.parent !== parent) continue;
        if (budget.frames-- <= 0) return;
        // One with no box on the page (a tracker's, mostly) is left out, as one the page hides is.
        const owner = await this.place(frame).then((levels) => levels.at(-1)!.owner, () => null);
        const host = owner === null ? undefined : into.get(owner);
        if (!host || (await this.closed(frame))) continue;
        const sub = await this.tree(frame.s, budget).catch(() => null);
        if (!sub?.nodes.length) continue;
        const id = (x: string) => `${frame.id}/${x}`;
        const own = new Set(sub.nodes.map((n) => n.nodeId));
        const root = sub.nodes.find((n) => n.parentId === undefined || !own.has(n.parentId));
        if (!root) continue;
        const copies = new Map<number, AXNode>();
        for (const n of sub.nodes) {
          const copy: AXNode = { ...n, nodeId: id(n.nodeId) };
          if (n.childIds) copy.childIds = n.childIds.map(id);
          if (n === root) copy.parentId = host.nodeId;
          else if (n.parentId !== undefined) copy.parentId = id(n.parentId);
          if (n.backendDOMNodeId !== undefined) {
            copy.backendDOMNodeId = this.refFor(frame, n.backendDOMNodeId);
            seen.add(copy.backendDOMNodeId);
            copies.set(n.backendDOMNodeId, copy);
          }
          page.nodes.push(copy);
        }
        host.childIds = [...(host.childIds ?? []), id(root.nodeId)];
        await hang(frame, copies, depth + 1);
      }
    };
    await hang(null, page.byRef, 1);
    // A frame that redraws itself for hours leaves refs to nodes long gone.
    if (this.frameRefs.size > MAX_FRAME_REFS) {
      for (const [ref, at] of this.frameRefs) {
        if (seen.has(ref)) continue;
        this.frameRefs.delete(ref);
        this.frameRefIds.delete(`${at.frame.id}:${at.node}`);
      }
    }
    return page.nodes;
  }

  /** One process's tree: a document and the frames of its own site in it, each hung under its <iframe>. */
  private async tree(s: CdpSession, budget: { frames: number }): Promise<{ nodes: AXNode[]; byRef: Map<number, AXNode> }> {
    const { nodes } = await s.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const { frameTree } = await s.send<{ frameTree: FrameTree }>("Page.getFrameTree");
    const byRef = new Map<number, AXNode>();
    for (const n of nodes) if (n.backendDOMNodeId !== undefined) byRef.set(n.backendDOMNodeId, n);
    const visit = async (tree: FrameTree, depth: number): Promise<void> => {
      if (depth > MAX_FRAME_DEPTH) return;
      for (const child of tree.childFrames ?? []) {
        if (budget.frames-- <= 0) return;
        const frameId = child.frame.id;
        const host = await s
          .send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId })
          .then((r) => byRef.get(r.backendNodeId), () => undefined);
        if (!host) continue;
        const sub = await s
          .send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId })
          .then((r) => r.nodes, () => null);
        if (!sub?.length) continue;
        // Node ids restart in every frame; refs (backend node ids) don't.
        const id = (x: string) => `${frameId}:${x}`;
        const own = new Set(sub.map((n) => n.nodeId));
        const root = sub.find((n) => n.parentId === undefined || !own.has(n.parentId));
        if (!root) continue;
        for (const n of sub) {
          const copy: AXNode = { ...n, nodeId: id(n.nodeId) };
          if (n.childIds) copy.childIds = n.childIds.map(id);
          if (n === root) copy.parentId = host.nodeId;
          else if (n.parentId !== undefined) copy.parentId = id(n.parentId);
          nodes.push(copy);
          if (copy.backendDOMNodeId !== undefined) byRef.set(copy.backendDOMNodeId, copy);
        }
        host.childIds = [...(host.childIds ?? []), id(root.nodeId)];
        await visit(child, depth + 1);
      }
    };
    await visit(frameTree, 1);
    return { nodes, byRef };
  }

  /** Visible text of the page and of the frames it shows (hidden elements excluded by innerText). */
  async readText(maxChars: number): Promise<{ url: string; title: string; text: string; truncated: number }> {
    const r = await this.evaluate<{ url: string; title: string; text: string }>(
      `({ url: location.href, title: document.title, text: (${FRAMES_TEXT})(document, 0) })`,
    );
    // After the page's own text, that of each frame from another site it shows.
    let left = MAX_FRAMES;
    for (const frame of [...this.outer.values()]) {
      if (left-- <= 0) break;
      try {
        if (await this.closed(frame)) continue;
        await this.place(frame);
        const inner = (await evaluateIn<string>(frame.s, `(${FRAMES_TEXT})(document, 0)`)).trim();
        if (inner) r.text += `\n\n${inner}`;
      } catch {
        // Not shown, or gone while it was being read.
      }
    }
    const text = r.text.replace(/\n{3,}/g, "\n\n").trim();
    return {
      ...r,
      text: text.slice(0, maxChars),
      truncated: Math.max(0, text.length - maxChars),
    };
  }

  /**
   * A JPEG of what the tab shows, and nothing beyond it. Fields that hold a
   * password, card, or one-time code are covered in black first and
   * uncovered right after, so the picture never carries them.
   */
  async screenshot(timeoutMs = 10_000, capture?: () => Promise<Buffer>): Promise<Buffer> {
    const rects = await this.evaluate<number[][]>(SENSITIVE_RECTS).then((r) => (Array.isArray(r) ? r : []));
    // Every frame from another site too, the ones the agent does not read included.
    for (const frame of [...this.outer.values()]) {
      try {
        const origin = (await this.place(frame)).at(-1)!;
        const inner = await evaluateIn<number[][]>(frame.s, SENSITIVE_RECTS);
        for (const [x, y, w, h] of Array.isArray(inner) ? inner : []) rects.push([origin.x + x!, origin.y + y!, w!, h!]);
      } catch {
        // Not shown: nothing of it is in the picture.
      }
    }
    await this.evaluate(maskScript(rects));
    try {
      const shot = capture
        ? capture()
        : this.s.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: false })
          .then((r) => Buffer.from(r.data, "base64"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageActionError("The page didn't produce a picture in time.")), timeoutMs);
      });
      try {
        return await Promise.race([shot, late]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await this.evaluate(UNMASK_SENSITIVE).catch(() => undefined);
    }
  }

  // -- navigation ----------------------------------------------------------

  async navigate(url: string): Promise<void> {
    this.loading = true;
    const r = await this.s.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) {
      this.loading = false;
      throw new PageActionError(`Could not load ${url}: ${r.errorText}`);
    }
    await this.waitForLoad(15_000);
  }

  async back(): Promise<boolean> {
    const h = await this.s.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const prev = h.entries[h.currentIndex - 1];
    if (!prev) return false;
    this.loading = true;
    await this.s.send("Page.navigateToHistoryEntry", { entryId: prev.id });
    await this.waitForLoad(15_000);
    return true;
  }

  /** Resolves true if the page finished loading, false on timeout. */
  waitForLoad(timeoutMs: number): Promise<boolean> {
    if (!this.loading) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        this.loadWaiters.delete(done);
        resolve(false);
      }, timeoutMs);
      this.loadWaiters.add(done);
    });
  }

  /** After an action: give navigation or re-rendering a moment to land. */
  async settle(): Promise<void> {
    await sleep(150);
    if (this.loading) await this.waitForLoad(8_000);
    await sleep(250);
  }

  // -- acting --------------------------------------------------------------

  async click(ref: number): Promise<void> {
    const { x, y } = await this.centre(ref);
    await this.uncovered(ref, x, y);
    await this.point({ kind: "click", x, y });
    await this.s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(ref: number, text: string, opts: { submit?: boolean; clear?: boolean } = {}): Promise<void> {
    const info = await this.describe(ref);
    if (info.inputType === "password") {
      throw new PageActionError(
        "This is a password field. Passwords are entered by the user, never by the assistant. Ask the user to type it themselves.",
      );
    }
    if (info.inputType === "hidden") throw new PageActionError(`Element [${ref}] is a hidden input and cannot be typed into.`);
    // A payment form is often a frame from the payment company; with those
    // readable, a card field is within reach, and it is the user's to fill.
    const card = await this.callOn<boolean>(ref, "function() { return ((this.getAttribute && this.getAttribute('autocomplete')) || '').trim().toLowerCase().startsWith('cc-'); }").catch(() => false);
    if (card) {
      throw new PageActionError(
        "This is a payment card field. Card details are entered by the user, never by the assistant. Call user_takeover so the user can fill them in.",
      );
    }

    // A field with no box of its own (some editors keep one off-screen) is
    // still typed into; one with a box must be the one the user can see.
    const at = await this.centre(ref).catch(() => null);
    if (at) {
      await this.uncovered(ref, at.x, at.y);
      await this.point({ kind: "type", ...at, text });
    }
    try {
      const at = this.at(ref);
      await at.s.send("DOM.focus", { backendNodeId: at.node });
    } catch {
      await this.click(ref);
    }
    if (opts.clear !== false) {
      await this.callOn(
        ref,
        "function() { if (typeof this.select === 'function') { this.select(); } else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }",
      );
    }
    await this.keyIn(text);
    if (opts.submit) await this.press("Enter");
  }

  /**
   * Key by key, as a person types: keydown, the character, keyup. Many
   * sites only react to key events — a menu search that filters on keyup,
   * an autocomplete on keydown — and inserted text fires neither. Long or
   * multi-line text is inserted whole: pressing Enter for a newline could
   * submit a form, and a message body needs no keystrokes.
   */
  private async keyIn(text: string): Promise<void> {
    if (text.length > MAX_KEYED || /[\r\n]/.test(text)) {
      await this.s.send("Input.insertText", { text });
      return;
    }
    for (const ch of text) {
      if (ch.length > 1) {
        await this.s.send("Input.insertText", { text: ch }); // outside the BMP, e.g. an emoji
        continue;
      }
      const code = /[a-z0-9 ]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
      const base = { key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await this.s.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: ch, unmodifiedText: ch });
      await this.s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
  }

  async press(key: string): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new PageActionError(`Unsupported key "${key}". Supported: ${Object.keys(KEYS).join(", ")}.`);
    await this.point({ kind: "key", key });
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.s.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text && { text: k.text }) });
    await this.s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async select(ref: number, option: string): Promise<string> {
    const r = await this.callOn<{ ok: boolean; chosen?: string; options?: string[] }>(
      ref,
      `function(wanted) {
        if (this.tagName !== 'SELECT') return { ok: false };
        const norm = (s) => s.trim().toLowerCase();
        const opts = [...this.options];
        const o = opts.find((o) => norm(o.label) === norm(wanted) || norm(o.value) === norm(wanted))
          || opts.find((o) => norm(o.label).includes(norm(wanted)));
        if (!o) return { ok: false, options: opts.slice(0, 30).map((o) => o.label) };
        this.value = o.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, chosen: o.label };
      }`,
      [option],
    );
    if (r.ok) return r.chosen!;
    if (r.options) throw new PageActionError(`No option matching "${option}". Options: ${r.options.join(" | ")}`);
    throw new PageActionError(`Element [${ref}] is not a dropdown (<select>). Click it instead to open custom menus.`);
  }

  /** Scrolls the page by most of a screen; returns how far down the page is. */
  async scroll(direction: "up" | "down"): Promise<number> {
    return this.evaluate<number>(
      `(() => { window.scrollBy(0, ${direction === "down" ? 1 : -1} * innerHeight * 0.8);
        const max = document.documentElement.scrollHeight - innerHeight;
        return max > 0 ? Math.round((scrollY / max) * 100) : 100; })()`,
    );
  }

  async scrollTo(ref: number): Promise<void> {
    const at = this.at(ref);
    // The frames it is in come into view first, outermost first: where the inner ones are drawn depends on it.
    if (at.frame) {
      for (const level of await this.place(at.frame)) await level.s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: level.owner }).catch(() => undefined);
    }
    await this.run(ref, () => at.s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: at.node }));
  }

  // -- helpers -------------------------------------------------------------

  private async point(p: PointerEvent): Promise<void> {
    try {
      await this.pointer?.(p);
    } catch {
      // Cosmetic; never let the cursor break an action.
    }
  }

  /**
   * Refuses an element something else is drawn over at its centre: the user
   * can't reach it there, and acting on it anyway goes somewhere they can't
   * see — text typed into a search box hidden behind a menu, for instance.
   * A label drawn over its own field counts as the field.
   */
  private async uncovered(ref: number, x: number, y: number): Promise<void> {
    // x and y are on the top page. In a frame from another site, each
    // <iframe> on the way in has to be what is drawn there in its own
    // document, and the element in its; each is asked in its own coordinates.
    const at = this.at(ref);
    let hit = true;
    let ox = 0;
    let oy = 0;
    for (const level of at.frame ? await this.place(at.frame) : []) {
      hit &&= await callOnNode<boolean>(level.s, level.owner, DRAWN_AT, [x - ox, y - oy]).catch(() => false);
      ox = level.x;
      oy = level.y;
    }
    hit &&= await this.run(ref, () => callOnNode<boolean>(at.s, at.node, DRAWN_AT, [x - ox, y - oy]));
    if (!hit) {
      throw new PageActionError(
        `Element [${ref}] is covered by something else (often a cookie banner, popup, menu or overlay). If what covers it has a field or button of its own for this, use that one; otherwise deal with it first, then try again.`,
      );
    }
  }

  private async centre(ref: number): Promise<{ x: number; y: number }> {
    await this.scrollTo(ref);
    const at = this.at(ref);
    const { quads } = await this.run(ref, () =>
      at.s.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: at.node }),
    );
    const quad = quads.find((q) => area(q) > 1);
    if (!quad) throw new PageActionError(`Element [${ref}] is not visible on the page, so it can't be clicked.`);
    const origin = at.frame ? (await this.place(at.frame)).at(-1)! : { x: 0, y: 0 };
    return {
      x: origin.x + (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: origin.y + (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  private async describe(ref: number): Promise<{ nodeName: string; inputType: string | null }> {
    const { node } = await this.run(ref, () =>
      this.at(ref).s.send<{ node: { nodeName: string; attributes?: string[] } }>("DOM.describeNode", { backendNodeId: this.at(ref).node }),
    );
    const attrs = node.attributes ?? [];
    const i = attrs.findIndex((a, n) => n % 2 === 0 && a.toLowerCase() === "type");
    const inputType = node.nodeName === "INPUT" ? (i >= 0 ? (attrs[i + 1] ?? "text").toLowerCase() : "text") : null;
    return { nodeName: node.nodeName, inputType };
  }

  private async callOn<T = unknown>(ref: number, fn: string, args: unknown[] = []): Promise<T> {
    const at = this.at(ref);
    return this.run(ref, () => callOnNode<T>(at.s, at.node, fn, args));
  }

  private evaluate<T>(expression: string): Promise<T> {
    return evaluateIn<T>(this.s, expression);
  }

  /** Maps CDP's "no node" errors to something the model can act on. */
  private async run<T>(ref: number, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/No node|detached|Could not find node|does not belong/i.test(msg)) {
        throw new PageActionError(`Element [${ref}] is no longer on the page. Call page_describe to get fresh refs.`);
      }
      throw err;
    }
  }
}

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

/** A frame from another site: it runs in a process of its own and is reached through a session of its own. */
interface OuterFrame {
  /** Its frame id, which is its target's too. */
  id: string;
  s: CdpSession;
  /** The frame from another site it sits in; null when it sits in the page itself. */
  parent: OuterFrame | null;
  /** Stops listening to its session, once it has left the page. */
  off: (() => void)[];
}

/**
 * Where refs into frames from other sites start. A page's own refs are its
 * node ids, counted from one in its process; these are counted by the driver
 * from above what a page usually reaches, and step aside if one does.
 */
const FRAME_REF_BASE = 100_000;

/** Refs into frames kept before the ones no longer on the page are dropped. */
const MAX_FRAME_REFS = 5_000;

/**
 * Whether the element is what is drawn at a point of its document: itself,
 * something in it or around it, or its label. Inside a frame of the same
 * site, the point is first brought into that frame's coordinates.
 */
const DRAWN_AT = `function(x, y) {
  let w = window;
  while (w.frameElement) {
    const f = w.frameElement, r = f.getBoundingClientRect(), cs = getComputedStyle(f);
    x -= r.left + f.clientLeft + parseFloat(cs.paddingLeft);
    y -= r.top + f.clientTop + parseFloat(cs.paddingTop);
    w = w.parent;
  }
  const h = document.elementFromPoint(x, y);
  return !!h && (h === this || this.contains(h) || h.contains(this) || (h.closest && h.closest('label') && h.closest('label').control === this));
}`;

async function callOnNode<T = unknown>(s: CdpSession, node: number, fn: string, args: unknown[] = []): Promise<T> {
  const { object } = await s.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: node });
  const r = await s.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(
    "Runtime.callFunctionOn",
    { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true },
  );
  if (r.exceptionDetails) throw new PageActionError(`Page script failed: ${r.exceptionDetails.text}`);
  return r.result.value as T;
}

async function evaluateIn<T>(s: CdpSession, expression: string): Promise<T> {
  const r = await s.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new PageActionError(`Page script failed: ${r.exceptionDetails.text}`);
  return r.result.value as T;
}

/** Frames read into one page: enough for framesets and portals, bounded for pages that nest ads. */
const MAX_FRAMES = 20;

/** innerText of a document and, after it, of each same-origin frame it shows. */
const FRAMES_TEXT = `function text(doc, depth) {
  let out = doc.body ? doc.body.innerText : '';
  if (depth >= ${MAX_FRAME_DEPTH}) return out;
  for (const f of doc.querySelectorAll('iframe, frame')) {
    let inner = null;
    try { inner = f.contentDocument; } catch (e) {}
    const r = f.getBoundingClientRect();
    if (!inner || r.width === 0 || r.height === 0) continue;
    const t = text(inner, depth + 1).trim();
    if (t) out += '\\n\\n' + t;
  }
  return out;
}`;

/** Longer text is inserted whole rather than typed key by key. */
const MAX_KEYED = 256;

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

function area(q: number[]): number {
  // Shoelace formula over the four corners.
  let a = 0;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    a += q[i]! * q[j + 1]! - q[j]! * q[i + 1]!;
  }
  return Math.abs(a) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
