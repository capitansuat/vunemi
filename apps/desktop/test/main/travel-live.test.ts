/** Opt-in smoke test for the two public travel MCP endpoints. Run with RUN_LIVE_TRAVEL=1. */
import { describe, expect, it } from "vitest";
import { travelConnectors } from "../../src/main/travel.js";

const live = process.env.RUN_LIVE_TRAVEL === "1" ? describe : describe.skip;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

live("live travel MCP", () => {
  it("returns flight cards with booking links", async () => {
    const connector = travelConnectors().find((c) => c.id === "travel-flights")!;
    const tool = connector.tools()[0]!;
    const output = await tool.run({ origin: "MAN", destination: "ADB", departure_date: future(25), return_date: future(30), adults: 1, children: 1, currency: "GBP" }, { signal: AbortSignal.timeout(120_000) } as never);
    const result = JSON.parse(String(output));
    expect(result).toMatchObject({ kind: "travel-options", source: "fli" });
    expect(String(output).length).toBeLessThan(12_000);
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options[0].url).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\//);
    expect(result.searchUrl).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\?/);
    await connector.disconnect?.();
  }, 150_000);

  it("returns hotel cards with Trivago offer links", async () => {
    const connector = travelConnectors().find((c) => c.id === "travel-hotels")!;
    const tool = connector.tools()[0]!;
    const output = await tool.run({ destination: "Izmir, Türkiye", check_in: future(1), currency: "GBP" }, { signal: AbortSignal.timeout(120_000) } as never);
    const result = JSON.parse(String(output));
    expect(result).toMatchObject({ kind: "travel-options", source: "trivago" });
    expect(String(output).length).toBeLessThan(12_000);
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options[0].url).toMatch(/^https:\/\/www\.trivago\./);
    expect(result.searchUrl).toMatch(/^https:\/\/www\.trivago\..*\/srl\/hotels\?/);
    expect(result.summary).toContain("1 yetişkin");
    expect(result.summary).toContain(future(2));
    await connector.disconnect?.();
  }, 150_000);
});
