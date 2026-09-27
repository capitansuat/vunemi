/**
 * The whole stack: a real local model driving a real Chrome on the real web.
 *
 *   OCAK_LIVE_MODEL=lmstudio:qwen/qwen3.6-35b-a3b pnpm vitest run live-agent
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModel, runAgent, ToolRegistry, type AgentEvent } from "@ocak/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchIsolatedChrome } from "../src/chrome.js";
import { BrowserController } from "../src/controller.js";
import { BROWSER_INSTRUCTIONS, createBrowserTools } from "../src/tools.js";

const spec = process.env.OCAK_LIVE_MODEL;

describe.skipIf(!spec)(`live agent: ${spec}`, () => {
  let profile = "";
  let browser: BrowserController;
  let tools: ToolRegistry;

  beforeAll(() => {
    profile = mkdtempSync(join(tmpdir(), "ocak-agent-"));
    browser = new BrowserController(() => launchIsolatedChrome({ userDataDir: profile, headless: true }));
    tools = new ToolRegistry();
    for (const t of createBrowserTools(browser)) tools.register(t);
  });

  afterAll(async () => {
    await browser?.dispose();
    rmSync(profile, { recursive: true, force: true });
  });

  async function task(goal: string) {
    const events: AgentEvent[] = [];
    const started = Date.now();
    const result = await runAgent({
      goal,
      model: createModel(spec!),
      tools,
      emit: (e) => events.push(e),
      instructions: BROWSER_INSTRUCTIONS,
      requestApproval: async () => ({ kind: "approve" }),
      maxSteps: 15,
    });
    const usage = events.flatMap((e) => (e.type === "usage" ? [e] : []));
    const report = {
      status: result.status,
      seconds: Math.round((Date.now() - started) / 1000),
      steps: usage.length,
      calls: events.flatMap((e) => (e.type === "tool.proposed" ? [`${e.tool}${e.preview ? ` ${e.preview}` : ""}`] : [])),
      failures: events.flatMap((e) => (e.type === "tool.finished" && !e.ok ? [e.output.slice(0, 160)] : [])),
      peakPromptTokens: Math.max(...usage.map((u) => u.promptTokens ?? 0)),
      answer: result.detail,
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  it("reads: finds the top story on Hacker News", { timeout: 300_000 }, async () => {
    const r = await task("Go to https://news.ycombinator.com and tell me the title of the #1 story right now.");
    expect(r.status).toBe("done");
    expect(r.calls[0]).toMatch(/^page_goto/);
    expect(r.answer.length).toBeGreaterThan(10);
  });

  it("acts: searches Wikipedia by typing into the search box", { timeout: 300_000 }, async () => {
    const r = await task(
      "Open https://en.wikipedia.org, use the site's search box to search for Mimar Sinan, and tell me in which year he was born according to the article.",
    );
    expect(r.status).toBe("done");
    expect(r.calls.some((c) => c.startsWith("page_type"))).toBe(true);
    expect(r.answer).toMatch(/1488|1489|1490/);
  });
});
