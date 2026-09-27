/**
 * The agent cursor overlay in a real headless Chrome: it must be invisible to
 * everything the agent reads and never get in the way of a click.
 * Skipped unless VUNEMI_LIVE_BROWSER=1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController, launchIsolatedChrome, PageDriver, type CdpSession } from "@vunemi/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cursorScript } from "../../src/main/agent-cursor.js";

const live = process.env.VUNEMI_LIVE_BROWSER === "1";
const PAGE = `data:text/html,${encodeURIComponent(
  "<title>T</title><button id=b onclick=\"this.textContent='clicked'\" style='position:fixed;left:100px;top:100px;width:120px;height:40px'>Press</button><p>Body text</p>",
)}`;

describe.skipIf(!live)("agent cursor overlay", () => {
  let profile = "";
  let browser: BrowserController;
  let session: CdpSession;
  let world = 0;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), "vunemi-cursor-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
    await browser.tabs(); // launch
    // Reach under the controller for a raw session on a fresh tab.
    const backend = await (browser as unknown as { ensure(): Promise<import("@vunemi/browser").BrowserBackend> }).ensure();
    const target = await backend.openTab("about:blank");
    session = await backend.attach(target);
    await session.send("Page.enable");
    await session.send("Page.navigate", { url: PAGE });
    await new Promise((r) => setTimeout(r, 500));
    const { frameTree } = await session.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    ({ executionContextId: world } = await session.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "vunemi-cursor",
    }));
  }, 60_000);

  afterAll(async () => {
    await browser?.dispose();
    rmSync(profile, { recursive: true, force: true });
  });

  const inWorld = (expression: string) =>
    session.send<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression,
      contextId: world,
      awaitPromise: true,
      returnByValue: true,
    });
  const inPage = async (expression: string) =>
    (await session.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true })).result
      .value;

  it("draws without touching what the agent reads or clicks", { timeout: 20_000 }, async () => {
    await inWorld(cursorScript({ kind: "click", x: 160, y: 120 }));

    // It's there: one more element under <html>, outside <body>.
    expect(await inPage("document.documentElement.children.length")).toBe(3);
    // The page's own scripts can't see our state.
    expect(await inPage("typeof window.__vunemiCursor")).toBe("undefined");
    // page_read's text is unchanged.
    expect(await inPage("document.body.innerText.includes('Vunemi')")).toBe(false);
    // Hit-testing goes straight through it.
    expect(await inPage("document.elementFromPoint(160, 120).id")).toBe("b");
    // And the accessibility tree has no trace of it.
    const { nodes } = await session.send<{ nodes: { ignored: boolean; name?: { value?: unknown } }[] }>(
      "Accessibility.getFullAXTree",
    );
    expect(nodes.some((n) => !n.ignored && String(n.name?.value ?? "").includes("Vunemi"))).toBe(false);

    // A real click through the driver still lands.
    const driver = await PageDriver.attach(session);
    const { nodeId } = await session
      .send<{ root: { nodeId: number } }>("DOM.getDocument")
      .then(({ root }) => session.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector: "#b" }));
    const { node } = await session.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    const seen: string[] = [];
    driver.pointer = (p) => void seen.push(p.kind);
    await driver.click(node.backendNodeId);
    expect(seen).toEqual(["click"]);
    expect(await inPage("document.getElementById('b').textContent")).toBe("clicked");
  });
});
