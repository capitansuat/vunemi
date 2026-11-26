/** What Windows leaves out, and how it says so. */
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, setSystem, t } from "@vunemi/i18n";
import type { ToolDef } from "@vunemi/agent-core";
import type { Connector } from "@vunemi/connectors";
import { darwin, windows } from "@vunemi/platform";
import { onThisSystem, withoutHelperTools } from "../../src/main/connectors.js";

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

const tool = (name: string): ToolDef => ({ name, description: "", parameters: { type: "object", properties: {} }, actionClass: "read", run: async () => "" });

afterEach(() => {
  setSystem("darwin");
  setLocale("tr");
});

describe("connections on Windows", () => {
  it("lists the macOS-only connections as not available on Windows, with no tools and off", async () => {
    setSystem("win32");
    setLocale("en");
    for (const id of ["desktop", "calendar", "reminders", "apps", "shortcuts"]) {
      const shown = onThisSystem(connector(id), windows);
      expect(shown.tools()).toEqual([]);
      expect(shown.capabilities ?? []).toEqual([]);
      expect(shown.defaultOn).toBe(false);
      expect(shown.unavailable).toBe("Not available on Windows yet: this connection needs macOS.");
      expect(await shown.status()).toEqual({ state: "blocked", reason: t("linux.connection") });
    }
  });

  it("keeps what Windows can do", () => {
    for (const id of ["browser", "files", "mail", "automations", "history", "github-mcp"]) {
      const original = connector(id);
      expect(onThisSystem(original, windows)).toBe(original);
    }
  });

  it("leaves out the page tools that need the Mac helper, and keeps the move vunemi-move does", () => {
    const tools = ["files_move", "page_target_observe", "page_target_act", "files_read"].map(tool);
    expect(withoutHelperTools(tools, windows).map((each) => each.name)).toEqual(["files_move", "files_read"]);
    expect(withoutHelperTools(tools, darwin)).toHaveLength(4);
  });

  it("keeps files_move wherever the move itself is on, apart from the screen tools", () => {
    const tools = ["files_move", "page_target_observe", "page_target_act", "files_read"].map(tool);
    const moving = { ...windows, features: { ...windows.features, desktopControl: false, atomicMove: true } };
    expect(withoutHelperTools(tools, moving).map((each) => each.name)).toEqual(["files_move", "files_read"]);
    const seeing = { ...darwin, features: { ...darwin.features, desktopControl: true, atomicMove: false } };
    expect(withoutHelperTools(tools, seeing).map((each) => each.name)).toEqual(["page_target_observe", "page_target_act", "files_read"]);
  });
});
