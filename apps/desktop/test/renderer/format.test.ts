import { describe, expect, it } from "vitest";
import { contextChoices, contextMemory, etaMinutes, formatGB, tooLarge } from "../../src/renderer/src/lib/format.js";

describe("download numbers", () => {
  it("shows sizes the way Hugging Face does, in the user's language", () => {
    expect(formatGB(22_360_456_160, "en")).toBe("22.4 GB");
    expect(formatGB(22_360_456_160, "tr")).toBe("22,4 GB");
    expect(formatGB(2_912_109_728, "en")).toBe("2.9 GB");
  });

  it("rounds the time left up to whole minutes, and has none without a speed", () => {
    expect(etaMinutes(600e6, 10e6)).toBe(1);
    expect(etaMinutes(601e6, 10e6)).toBe(2);
    expect(etaMinutes(1e9, 0)).toBeNull();
  });
});

describe("context length choices", () => {
  it("go up to what the model was trained for, and include it", () => {
    expect(contextChoices(65_536, 262_144)).toEqual([8192, 16384, 32768, 65536, 131072, 262144]);
    expect(contextChoices(32_768, 40_960)).toEqual([8192, 16384, 32768, 40960]);
  });

  it("keep a length set some other way", () => {
    expect(contextChoices(20_000, 32_768)).toEqual([8192, 16384, 20000, 32768]);
  });
});

describe("memory for a context length", () => {
  it("adds the weights, the context's cache and working buffers", () => {
    // Qwen3.6-35B-A3B Q4: ~22 GB of weights, 20 KB per token.
    const at32k = contextMemory(22e9, 20_480, 32_768)!;
    const at256k = contextMemory(22e9, 20_480, 262_144)!;
    expect(at256k - at32k).toBe(20_480 * (262_144 - 32_768));
    expect(at32k).toBeGreaterThan(22e9 + 20_480 * 32_768);
  });

  it("says nothing when the model file doesn't tell", () => {
    expect(contextMemory(22e9, undefined, 32_768)).toBeNull();
  });

  it("flags more than three quarters of the Mac's memory", () => {
    expect(tooLarge(49e9, 64e9)).toBe(true);
    expect(tooLarge(40e9, 64e9)).toBe(false);
  });
});
