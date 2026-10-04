import { describe, expect, it } from "vitest";
import { macMemory, need, parseFootprint, parsePressure, parseVmStat } from "../../src/main/models/memory.js";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    96768.
Pages active:                                1666080.
Pages inactive:                              1661808.
Pages speculative:                              3604.
Pages throttled:                                   0.
Pages wired down:                             294114.
Pages purgeable:                              116516.
"Translation faults":                     6767964283.
`;

const FOOTPRINT = `======================================================================
llama-server [25103]: 64-bit    Footprint: 126 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
`;

describe("reading macOS memory", () => {
  it("counts free, inactive, speculative and purgeable pages at the page size vm_stat prints", () => {
    expect(parseVmStat(VM_STAT)).toBe(30_780_555_264);
    expect(parseVmStat("Pages free: 12.")).toBeNull();
    expect(parseVmStat(VM_STAT.replace(/Pages purgeable:.*\n/, ""))).toBeNull();
  });

  it("reads a process's footprint in any unit", () => {
    expect(parseFootprint(FOOTPRINT)).toBe(132_120_576);
    expect(parseFootprint("zsh [23220]: 64-bit    Footprint: 1728 KB (16384 bytes per page)")).toBe(1_769_472);
    expect(parseFootprint("x [1]: 64-bit    Footprint: 22.4 GB (16384 bytes per page)")).toBe(24_051_816_858);
    expect(parseFootprint("footprint: no process")).toBeNull();
  });

  it("knows only the three pressure levels", () => {
    expect(parsePressure("1\n")).toBe(1);
    expect(parsePressure("2")).toBe(2);
    expect(parsePressure("4\n")).toBe(4);
    expect(parsePressure("7")).toBeNull();
    expect(parsePressure("")).toBeNull();
  });

  it("estimates a launch: the file, the KV cache for the context, and half a GiB", () => {
    expect(need(1_000_000_000, 100_000, 8_192)).toBe(2_356_070_912);
    // The file does not say: the KV cache counts as a fifth of it, whatever the context.
    expect(need(1_000_000_000, null, 65_536)).toBe(1_736_870_912);
  });

  it("asks macOS's own tools, and says null when one fails", async () => {
    const asked: string[] = [];
    const reader = macMemory(async (cmd, args) => {
      asked.push([cmd, ...args].join(" "));
      if (cmd.endsWith("vm_stat")) return VM_STAT;
      if (cmd.endsWith("footprint")) throw new Error("no such process");
      return "2\n";
    });
    expect(await reader.available()).toBe(30_780_555_264);
    expect(await reader.footprint(42)).toBeNull();
    expect(await reader.pressure()).toBe(2);
    expect(asked).toEqual(["/usr/bin/vm_stat", "/usr/bin/footprint -p 42", "/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level"]);
  });
});
