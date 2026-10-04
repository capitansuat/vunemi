// Prompt budget: what every request carries before the conversation starts.
// On a local model each 1,000 tokens of prompt costs about three seconds
// whenever the cache misses, and the prompt grew from ~4k to ~12k tokens
// without anyone noticing. These limits make growth a decision: if a test
// here fails, shorten the text, or raise the limit in the same commit and
// say why. Nothing here limits the app at run time.
//
// PROMPT_REPORT=1 prints the whole composition.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => {
  const anything: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : anything), apply: () => anything, construct: () => anything });
  return { default: anything, app: anything, BrowserWindow: anything, session: anything, shell: anything, net: anything, Notification: anything };
});

/**
 * Characters, not tokens: no tokenizer needed; about 3.6 characters a token.
 * Set just above what was there on 2 October 2026, so nothing grows unseen;
 * lower them as the prompt is trimmed.
 */
const LIMITS = {
  /** The system prompt itself (1,806). */
  core: 1_900,
  /** One tool's definition: name, description and parameters (largest 782, travel_search_flights). */
  tool: 800,
  /** One connection's instructions (largest 1,999, apps). */
  guide: 2_000,
  /** System prompt, every connection's instructions and every tool shown, all switched on (37,019). */
  total: 38_000,
  /** With areas: a conversation's first prompt with one area picked, the largest (11,743, browser). */
  oneArea: 12_000,
};

async function compose() {
  const { ToolRegistry, toolSpecsOf, SYSTEM_PROMPT, KeptOutputs, keptOutputTools, listedRequest, areaOf } = await import("@vunemi/agent-core");
  const { toolAreas } = await import("../../src/main/areas.js");
  const { ScriptableCatalog } = await import("@vunemi/apps");
  const { buildConnectors } = await import("../../src/main/connectors.js");
  const { AutomationStore } = await import("../../src/main/automations.js");
  const dir = mkdtempSync(join(tmpdir(), "vunemi-budget-"));
  const tools = new ToolRegistry();
  // As in main: tools that read long output kept whole.
  for (const tool of keptOutputTools(new KeptOutputs())) tools.register(tool);
  const connectors = buildConnectors({
    tools, browser: {} as never, roots: { list: () => [] } as never, appCatalog: new ScriptableCatalog(join(dir, "apps")),
    shadowDir: join(dir, "shadow"), helper: {} as never, shotDir: join(dir, "shots"),
    automations: new AutomationStore(join(dir, "automations.json")), mailAccounts: [],
  });
  // Everything switched on: the most a user can carry.
  for (const view of await connectors.list()) {
    connectors.setOn(view.id, true);
    for (const part of view.parts) connectors.setPartOn(view.id, part.id, true);
  }
  const guides = connectors.onIds().flatMap((id) => {
    const text = (connectors.get(id) as { instructions?: string } | undefined)?.instructions ?? "";
    return text ? [{ id, chars: text.length }] : [];
  });
  // As a run starts: on-demand groups closed, switched-off tools offered.
  const shown = toolSpecsOf(tools, new Set<string>(), (name) => !!connectors.partOf(name));
  const specs = shown.map((s) => ({ name: s.name, chars: JSON.stringify(s).length }));
  const onDemand = toolSpecsOf(tools).filter((s) => !shown.some((x) => x.name === s.name)).map((s) => ({ name: s.name, chars: JSON.stringify(s).length }));
  const instructions = connectors.instructions().length;
  // As a conversation starts with areas: built-in tools, automation_create,
  // and one picked area; each area tried, the largest kept.
  const areas = toolAreas(connectors.working());
  const shared = connectors.instructions({ guides: false });
  const listedFor = (area: string) => {
    const names = new Set(shown.filter((s) => { const def = tools.getAny(s.name); const a = def ? areaOf(tools, def) : undefined; return a === undefined || a === area || s.name === "automation_create"; }).map((s) => s.name));
    const r = listedRequest(tools, areas, names, shared);
    return { area, chars: r.system.length + JSON.stringify(r.tools).length };
  };
  const perArea = areas.filter((a) => a.routed !== false).map((a) => listedFor(a.id)).sort((a, b) => b.chars - a.chars);
  const none = listedFor("");
  return { perArea, none, core: SYSTEM_PROMPT.length, guides, specs, onDemand, instructions, total: SYSTEM_PROMPT.length + instructions + specs.reduce((n, s) => n + s.chars, 0) };
}

describe("prompt budget", async () => {
  const c = await compose();
  const tok = (chars: number) => `~${Math.round(chars / 3.6)} tok`;

  if (process.env.PROMPT_REPORT) {
    const lines = [
      `core ${tok(c.core)}`, `instructions ${tok(c.instructions)}`,
      `tools shown: ${c.specs.length}, ${tok(c.specs.reduce((n, s) => n + s.chars, 0))}; on demand: ${c.onDemand.length}, ${tok(c.onDemand.reduce((n, s) => n + s.chars, 0))}`,
      `with areas: nothing picked ${tok(c.none.chars)}; one area, largest ${c.perArea[0]!.area} ${tok(c.perArea[0]!.chars)} (${c.perArea[0]!.chars} chars)`,
      `total ${tok(c.total)} (${c.total} chars; core ${c.core}, largest tool ${Math.max(...[...c.specs, ...c.onDemand].map((s) => s.chars))}, largest guide ${Math.max(...c.guides.map((g) => g.chars))})`, "", "guides:", ...c.guides.sort((a, b) => b.chars - a.chars).map((g) => `  ${g.id.padEnd(16)} ${tok(g.chars)}`),
      "", "largest tools:", ...[...c.specs, ...c.onDemand].sort((a, b) => b.chars - a.chars).slice(0, 15).map((s) => `  ${s.name.padEnd(28)} ${tok(s.chars)}`),
    ];
    process.stdout.write(`\n${lines.join("\n")}\n`);
  }

  it("keeps the system prompt within its budget", () => {
    expect(c.core).toBeLessThanOrEqual(LIMITS.core);
  });

  it("keeps every tool definition within its budget", () => {
    const over = [...c.specs, ...c.onDemand].filter((s) => s.chars > LIMITS.tool).map((s) => `${s.name} ${s.chars}`);
    expect(over).toEqual([]);
  });

  it("keeps every connection's instructions within budget", () => {
    const over = c.guides.filter((g) => g.chars > LIMITS.guide).map((g) => `${g.id} ${g.chars}`);
    expect(over).toEqual([]);
  });

  it("keeps a conversation's first prompt with one area within budget", () => {
    expect(c.perArea[0]!.chars).toBeLessThanOrEqual(LIMITS.oneArea);
  });

  it("keeps the whole first prompt within budget", () => {
    expect(c.total).toBeLessThanOrEqual(LIMITS.total);
  });
});
