import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpSession } from "../src/index.js";
import { createBrowserTools } from "../src/tools.js";
import { PageDriver } from "../src/page.js";

/** A CDP session that records what was sent and answers from a table. */
function session(capture: () => Promise<{ data: string }>) {
  const sent: string[] = [];
  const s = {
    on: () => {},
    send: vi.fn(async (method: string, params?: { expression?: string }) => {
      if (method === "Runtime.evaluate") {
        const expr = params?.expression ?? "";
        sent.push(expr.includes("data-vunemi-mask") && expr.includes("remove") ? "unmask" : expr.includes("data-vunemi-mask") ? "mask" : "eval");
        return { result: { value: expr.includes("location.href") ? { url: "https://example.com/", title: "Example" } : true } };
      }
      sent.push(method);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.captureScreenshot") return capture();
      return {};
    }),
  } as unknown as CdpSession;
  return { s, sent };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("a picture of the tab", () => {
  it("covers sensitive fields, takes only the visible part, and uncovers them", async () => {
    const { s, sent } = session(async () => ({ data: Buffer.from("jpeg-bytes").toString("base64") }));
    const driver = await PageDriver.attach(s);
    const image = await driver.screenshot();
    expect(image.toString()).toBe("jpeg-bytes");
    expect(sent.slice(-3)).toEqual(["mask", "Page.captureScreenshot", "unmask"]);
    const call = (s.send as ReturnType<typeof vi.fn>).mock.calls.find(([m]) => m === "Page.captureScreenshot")!;
    expect(call[1]).toMatchObject({ format: "jpeg", captureBeyondViewport: false });
  });

  it("uses the host's own capture when there is one, still masked around it", async () => {
    const { s, sent } = session(async () => ({ data: "" }));
    const driver = await PageDriver.attach(s);
    const capture = vi.fn(async () => {
      sent.push("host-capture");
      return Buffer.from("fresh");
    });
    expect((await driver.screenshot(1000, capture)).toString()).toBe("fresh");
    expect(sent.slice(-3)).toEqual(["mask", "host-capture", "unmask"]);
    expect(sent).not.toContain("Page.captureScreenshot");
  });

  it("uncovers the fields even when the picture never comes", async () => {
    const { s, sent } = session(() => new Promise(() => {}));
    const driver = await PageDriver.attach(s);
    await expect(driver.screenshot(50)).rejects.toThrow(/in time/);
    expect(sent.at(-1)).toBe("unmask");
  });

  it("masks password, card and one-time-code fields", async () => {
    const { s } = session(async () => ({ data: "" }));
    const driver = await PageDriver.attach(s);
    await driver.screenshot();
    const mask = (s.send as ReturnType<typeof vi.fn>).mock.calls.map(([, p]) => (p as { expression?: string } | undefined)?.expression ?? "").find((e) => e.includes("querySelectorAll") && !e.includes("remove()"))!;
    for (const selector of ["input[type=password]", '[autocomplete^="cc-"]', '[autocomplete="one-time-code"]']) expect(mask).toContain(selector);
  });
});

describe("page_screenshot", () => {
  const ctx = (attached: unknown[]) => ({ signal: new AbortController().signal, attach: (a: unknown) => attached.push(a) }) as never;
  const tool = (browser: object, shotDir?: string) => createBrowserTools(browser as never, shotDir ? { shotDir } : {}).find((t) => t.name === "page_screenshot");

  it("exists only when there is somewhere to keep pictures", () => {
    expect(tool({})).toBeUndefined();
    expect(tool({}, "/tmp/x")).toBeDefined();
  });

  it("attaches the picture for the model and the user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-shot-"));
    dirs.push(dir);
    const path = join(dir, "page.jpg");
    const attached: unknown[] = [];
    const out = await tool({ challenge: null, screenshot: async () => ({ path, url: "https://example.com/", title: "Example" }) }, dir)!.run({}, ctx(attached));
    expect(attached).toEqual([{ kind: "image", path, label: "Example" }]);
    expect(out).toContain("blacked out");
  });

  it("takes no picture of a bot check, and says so when it can't take one", async () => {
    const screenshot = vi.fn();
    const attached: unknown[] = [];
    const out = await tool({ challenge: "CAPTCHA", screenshot }, "/tmp/x")!.run({}, ctx(attached));
    expect(screenshot).not.toHaveBeenCalled();
    expect(out).toContain("CAPTCHA");
    const failed = await tool({ challenge: null, screenshot: async () => { throw new Error("no frame"); } }, "/tmp/x")!.run({}, ctx(attached));
    expect(failed).toContain("page_read");
    expect(attached).toEqual([]);
  });
});
