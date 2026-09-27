import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Roots } from "@vunemi/files";
import { Connectors } from "@vunemi/connectors";
import { overheadChars, ToolRegistry } from "@vunemi/agent-core";
import { ScriptableCatalog } from "@vunemi/apps";
import { appsConnector } from "../../src/main/connectors.js";

let dir: string;
let fake: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-apps-"));
  fake = join(dir, "osascript");
  // Refuses Automation for Notes, answers an empty list otherwise.
  writeFileSync(fake, `#!/usr/bin/env node
const a = JSON.parse(process.argv.at(-1));
if (a.app === "Notes") { process.stderr.write("execution error: Not authorized to send Apple events to Notes. (-1743)"); process.exit(1); }
process.stdout.write("[]");
`);
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the Mac apps connection", () => {
  it("is off by default, with Notes and Finder as separate switches", () => {
    const c = appsConnector({ roots: new Roots([dir]), catalog: new ScriptableCatalog(join(dir, "cache"), []), osascript: fake });
    expect(c.defaultOn).toBe(false);
    expect(c.capabilities?.find((cap) => cap.id === "request")).toMatchObject({ defaultOn: true, hidden: true });
    expect(c.capabilities?.filter((cap) => !cap.hidden).map((cap) => [cap.id, cap.tools])).toEqual([
      ["notes", ["notes_search", "notes_read", "notes_create", "notes_append"]],
      ["notes-change", ["notes_edit", "notes_delete"]],
      ["finder", ["finder_selection", "finder_reveal"]],
    ]);
    expect(c.capabilities?.find((cap) => cap.id === "notes-change")?.defaultOn).toBe(false);
  });

  it("shows only the existing Notes and Finder switches while keeping generic tools behind the parent", async () => {
    const registry = new ToolRegistry();
    const connections = new Connectors({ tools: registry });
    connections.add(appsConnector({ roots: new Roots([dir]), catalog: new ScriptableCatalog(join(dir, "cache"), []), osascript: fake }));
    expect(registry.get("app_dictionary")).toBeUndefined();
    connections.setOn("apps", true);
    expect(registry.get("app_dictionary")).toBeDefined();
    const view = (await connections.list()).find((row) => row.id === "apps")!;
    expect(view.parts.map((part) => part.id)).toEqual(["notes", "notes-change", "finder"]);
  });

  it("shows a refused permission as blocked until a call works again", async () => {
    const c = appsConnector({ roots: new Roots([dir]), catalog: new ScriptableCatalog(join(dir, "cache"), []), osascript: fake });
    const tools = c.tools();
    expect(await c.status()).toEqual({ state: "ready" });
    // Tests run in Turkish (the catalogue default), so check the macOS code, not the wording.
    await expect(tools.find((t) => t.name === "notes_search")!.run({ query: "x" }, {} as never)).rejects.toMatchObject({ code: -1743 });
    expect(await c.status()).toMatchObject({ state: "blocked", settings: "automation" });
    await tools.find((t) => t.name === "finder_selection")!.run({}, {} as never);
    expect(await c.status()).toMatchObject({ state: "blocked" }); // Finder working says nothing about Notes
  });

  it("keeps every app tool but Notes, Finder and the guide behind a group, and drops none", () => {
    const c = appsConnector({ roots: new Roots([dir]), catalog: new ScriptableCatalog(join(dir, "cache"), []), osascript: fake });
    const tools = c.tools();
    const visible = tools.filter((tool) => !tool.onDemand).map((tool) => tool.name);
    expect(visible).toEqual(["notes_search", "notes_read", "notes_create", "notes_append", "notes_edit", "notes_delete", "finder_selection", "finder_reveal", "app_guide"]);
    const listed = c.capabilities!.flatMap((cap) => cap.tools);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...listed].sort());
    for (const name of ["messages_send", "photos_search", "excel_write_range", "app_command"]) expect(tools.find((tool) => tool.name === name)?.onDemand).toBeTruthy();
  });

  it("sends a much smaller request until a guide opens a group", () => {
    const registry = new ToolRegistry();
    const connections = new Connectors({ tools: registry });
    connections.add(appsConnector({ roots: new Roots([dir]), catalog: new ScriptableCatalog(join(dir, "cache"), []), osascript: fake }));
    connections.setOn("apps", true);
    const all = overheadChars(registry, connections.instructions());
    const idle = overheadChars(registry, connections.instructions(), new Set());
    const office = overheadChars(registry, connections.instructions(), new Set(["office"]));
    expect(idle).toBeLessThan(all * 0.6);
    expect(office).toBeGreaterThan(idle);
    expect(office).toBeLessThan(all);
  });
});
