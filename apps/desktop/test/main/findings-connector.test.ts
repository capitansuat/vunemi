/** The findings tools come and go with the browser's reading part, never on their own. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolDef } from "@vunemi/agent-core";
import { ScriptableCatalog } from "@vunemi/apps";
import { buildConnectors } from "../../src/main/connectors.js";
import { AutomationStore } from "../../src/main/automations.js";
import { Library } from "../../src/main/library/library.js";
import { LibraryStore } from "../../src/main/library/store.js";

const fake = (name: string): ToolDef => ({ name, description: "", parameters: { type: "object", properties: {} }, actionClass: "read", run: async () => "" });

describe("findings tools", () => {
  it("are offered only while the browser is on, as part of its reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-findings-conn-"));
    const store = new LibraryStore(dir);
    try {
      const tools = new ToolRegistry();
      const sources = { conversations: () => [], conversation: () => null, meetings: () => [], meeting: () => null };
      const connectors = buildConnectors({
        tools, browser: {} as never, roots: { list: () => [] } as never, appCatalog: new ScriptableCatalog(join(dir, "apps")),
        shadowDir: join(dir, "shadow"), helper: {} as never, shotDir: join(dir, "shots"),
        automations: new AutomationStore(join(dir, "automations.json")), mailAccounts: [],
        library: { library: new Library(store, sources), sources, current: () => "" },
        findingTools: [fake("web_finding_add")],
      });
      connectors.setOn("browser", false);
      expect(tools.get("web_finding_add")).toBeUndefined();
      connectors.setOn("browser", true);
      expect(tools.get("web_finding_add")).toBeDefined();
      expect(connectors.partOf("web_finding_add")).toBeNull();
      connectors.setPartOn("browser", "read", false);
      expect(connectors.partOf("web_finding_add")).toMatchObject({ connectorId: "browser", partId: "read" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
