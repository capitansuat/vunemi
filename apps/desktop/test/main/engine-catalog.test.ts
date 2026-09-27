import { describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { CATALOG, contextFor, displayName, GiB, memoryBudget, modelId, recommend, smaller } from "../../src/main/engine/catalog.js";

describe("the recommended models", () => {
  it("offers the biggest model that fits the Mac", () => {
    expect(recommend(64 * GiB).file).toBe("Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf");
    expect(recommend(36 * GiB).file).toBe("Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf");
    expect(recommend(16 * GiB).file).toBe("Qwen3.5-9B-UD-Q4_K_XL.gguf");
    expect(recommend(8 * GiB).file).toBe("gemma-4-E2B-it-Q4_0.gguf");
  });

  it("steps down one size at a time, and stops at the smallest", () => {
    const chain: string[] = [];
    for (let e: ReturnType<typeof smaller> = CATALOG[0]!; e; e = smaller(e.file)) chain.push(e.file);
    expect(chain).toEqual(CATALOG.map((e) => e.file));
    expect(smaller("nope.gguf")).toBeNull();
  });

  it("keeps every entry checkable and inside its own memory budget", () => {
    for (const e of CATALOG) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(e.file).toMatch(/^[^/\\]+\.gguf$/);
      expect(e.size).toBeGreaterThan(0);
      if (e.minMemory > 0) expect(e.size).toBeLessThanOrEqual(memoryBudget(e.minMemory));
    }
    for (const e of CATALOG.filter((e) => e.projector)) {
      expect(e.projector?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.projector?.file).toBe("mmproj-F16.gguf");
    }
    // Only the one for the smallest Macs goes without eyes.
    expect(CATALOG.filter((e) => !e.projector).map((e) => e.name)).toEqual(["Gemma 4 E2B"]);
    expect(CATALOG[0]!.projector).toEqual({
      file: "mmproj-F16.gguf", size: 899_283_680, sha256: "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f",
    });
    const floors = CATALOG.map((e) => e.minMemory);
    expect([...floors].sort((a, b) => b - a)).toEqual(floors);
  });

  it("sizes the context to the memory", () => {
    expect(contextFor(64 * GiB)).toBe(65_536);
    expect(contextFor(32 * GiB)).toBe(32_768);
    expect(contextFor(8 * GiB)).toBe(16_384);
  });

  it("names a model after its file", () => {
    expect(modelId("Qwen3.5-4B-UD-Q4_K_XL.gguf")).toBe("qwen3.5-4b-ud-q4_k_xl");
  });
});

describe("model names", () => {
  it("names the smaller build in the user's language, also for older downloads", () => {
    setLocale("de");
    expect(displayName("Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf", "Qwen3.6 35B-A3B (compact)")).toBe("Qwen3.6 35B-A3B (kompakt)");
    expect(displayName("Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf", "x")).toBe("Qwen3.6 35B-A3B");
    expect(displayName("other.gguf", "Someone's model")).toBe("Someone's model");
    setLocale("tr");
  });
});
