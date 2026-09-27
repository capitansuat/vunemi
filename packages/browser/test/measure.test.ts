/**
 * Measures how much the outline shrinks real pages. Not a pass/fail test —
 * it prints a table. Run with VUNEMI_MEASURE=1 (needs network and Chrome).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outline } from "@vunemi/perception";
import { describe, it } from "vitest";
import { launchIsolatedChrome } from "../src/chrome.js";
import { PageDriver } from "../src/page.js";

const SITES = [
  "https://en.wikipedia.org/wiki/Istanbul",
  "https://www.bbc.com/news",
  "https://github.com/browser-use/browser-use",
  "https://news.ycombinator.com",
  "https://www.amazon.com/s?k=running+shoes",
  "https://www.hepsiburada.com/ara?q=kulaklik",
];

describe.skipIf(process.env.VUNEMI_MEASURE !== "1")("outline size on real pages", () => {
  it("prints raw vs pruned sizes", { timeout: 300_000 }, async () => {
    const profile = mkdtempSync(join(tmpdir(), "vunemi-measure-"));
    // Headful, like the app itself: some sites (hepsiburada) detect headless
    // Chrome and answer with a wall, which would make this table a lie.
    const backend = await launchIsolatedChrome({ userDataDir: profile, headless: false });
    const rows: string[] = [];
    try {
      for (const url of SITES) {
        const target = await backend.openTab("about:blank");
        try {
          const page = await PageDriver.attach(await backend.attach(target));
          await page.navigate(url);
          await new Promise((r) => setTimeout(r, 1500));
          const nodes = await page.axNodes();
          const raw = JSON.stringify(nodes).length;
          const full = outline(nodes);
          const budget = outline(nodes, { maxChars: 16_000 });
          const inter = outline(nodes, { interactiveOnly: true });
          const tok = (c: number) => `${Math.round(c / 4 / 100) / 10}K`;
          rows.push(
            [
              new URL(url).hostname.padEnd(24),
              String(nodes.length).padStart(6),
              tok(raw).padStart(8),
              tok(full.stats.chars).padStart(8),
              tok(inter.stats.chars).padStart(8),
              `${(raw / full.stats.chars).toFixed(0)}×`.padStart(6),
              String(budget.stats.omittedNodes).padStart(8),
            ].join(" "),
          );
        } catch (err) {
          rows.push(`${new URL(url).hostname.padEnd(24)} error: ${String(err).slice(0, 80)}`);
        } finally {
          await backend.closeTab(target);
        }
      }
    } finally {
      await backend.close();
      rmSync(profile, { recursive: true, force: true });
    }
    console.log(
      [
        `${"site".padEnd(24)} ${"nodes".padStart(6)} ${"raw".padStart(8)} ${"outline".padStart(8)} ${"interact".padStart(8)} ${"shrink".padStart(6)} ${"cut@16K".padStart(8)}`,
        "(sizes in tokens, ≈ chars/4)",
        ...rows,
      ].join("\n"),
    );
  });
});
