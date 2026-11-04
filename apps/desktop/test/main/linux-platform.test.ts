/** What Linux leaves out, and how it says so. macOS keeps every connection as it is. */
import { describe, expect, it } from "vitest";
import { t } from "@vunemi/i18n";
import type { Connector } from "@vunemi/connectors";
import { darwin, linux } from "@vunemi/platform";
import { onThisSystem, unavailableHere } from "../../src/main/connectors.js";
import { linuxMemory, parseMeminfo, parseProcStatus } from "../../src/main/models/memory.js";

const connector = (id: string): Connector => ({
  id,
  label: `label-${id}`,
  group: "computer",
  description: `description-${id}`,
  provides: ["x"],
  capabilities: [{ id: "act", label: "act", tools: ["danger_tool"], defaultOn: true }],
  needs: { kind: "permission", what: "Accessibility" },
  defaultOn: true,
  origin: "builtin",
  status: async () => ({ state: "ready" }),
  tools: () => [{ name: "danger_tool", description: "", parameters: { type: "object", properties: {} }, actionClass: "write-local", run: async () => "ran" }],
});

describe("connections on Linux", () => {
  it("lists the macOS-only connections as not available yet, with no tools and off", async () => {
    for (const id of ["desktop", "calendar", "reminders", "apps", "shortcuts"]) {
      const shown = onThisSystem(connector(id), linux);
      expect(shown.label).toBe(`label-${id}`);
      expect(shown.tools()).toEqual([]);
      expect(shown.capabilities ?? []).toEqual([]);
      expect(shown.defaultOn).toBe(false);
      expect(shown.unavailable).toBe(t("linux.connection"));
      expect(await shown.status()).toEqual({ state: "blocked", reason: t("linux.connection") });
    }
  });

  it("keeps everything that is not tied to macOS", () => {
    for (const id of ["browser", "files", "mail", "automations", "history", "travel-flights", "github-mcp"]) {
      const original = connector(id);
      expect(onThisSystem(original, linux)).toBe(original);
    }
  });

  it("changes nothing on macOS", () => {
    for (const id of ["desktop", "calendar", "reminders", "apps", "shortcuts", "files"]) {
      const original = connector(id);
      expect(onThisSystem(original, darwin)).toBe(original);
    }
  });

  it("asks for no macOS permission where it can't be given", () => {
    expect(unavailableHere(connector("desktop")).needs).toEqual({ kind: "none" });
  });
});

describe("memory readings on Linux", () => {
  it("reads MemAvailable and a process's own anonymous memory", () => {
    expect(parseMeminfo("MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n")).toBe(8_000_000 * 1024);
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
    expect(parseProcStatus("Name:\tllama-server\nRssAnon:\t  204800 kB\nRssFile:\t 4000000 kB\n")).toBe(204_800 * 1024);
    expect(parseProcStatus("Name:\tx\n")).toBeNull();
  });

  it("reads /proc, and gives null rather than a guess", async () => {
    const files: Record<string, string> = { "/proc/meminfo": "MemAvailable: 1024 kB\n", "/proc/42/status": "RssAnon: 2 kB\n" };
    const reader = linuxMemory(async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    });
    expect(await reader.available()).toBe(1024 * 1024);
    expect(await reader.footprint(42)).toBe(2048);
    expect(await reader.footprint(7)).toBeNull();
    expect(await reader.footprint(-1)).toBeNull();
    expect(await reader.pressure()).toBeNull();
  });
});
