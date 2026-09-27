import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ToolContext } from "@ocak/agent-core";
import { blockedApp, type ScriptableCatalog } from "../src/catalog.js";
import { blockedCommand, classifyCommand, parseDictionary } from "../src/dictionary.js";
import { createGeneralTools, GENERAL_GET, GENERAL_COMMAND } from "../src/general.js";

const xml = `<?xml version="1.0"?><dictionary><suite name="Demo">
  <class-extension extends="application"><element type="document"/></class-extension>
  <class name="item"><property name="name" type="text"/></class>
  <class name="document" inherits="item"><property name="text" type="text"/></class>
  <command name="get"><direct-parameter type="specifier"/></command>
  <command name="make"><parameter name="new" type="type"/></command>
  <command name="send"><direct-parameter type="text"/><parameter name="to" type="text"/></command>
  <command name="delete"><direct-parameter type="specifier"/></command>
  <command name="do JavaScript"><direct-parameter type="text"/></command>
</suite></dictionary>`;
const standard = `<dictionary><suite name="Standard"><class name="application"><property name="name" type="text"/></class></suite></dictionary>`;
const dictionary = parseDictionary(xml, standard);
const app = { name: "Demo", bundleId: "com.example.demo", path: "/Applications/Demo.app", version: "1" };
const catalog = { list: async () => [app], find: async () => app, dictionary: async () => dictionary } as unknown as ScriptableCatalog;
const ctx = {} as ToolContext;
const tools = (run = vi.fn(async () => "ok")) => ({
  run,
  list: createGeneralTools({ catalog, run }),
});
const tool = (list: ReturnType<typeof createGeneralTools>, name: string) => list.find((entry) => entry.name === name)!;

describe("Mac app scripting dictionary", () => {
  it("parses only declarative entries and refuses code commands", () => {
    expect(dictionary.classes.find((entry) => entry.name === "application")?.elements[0]).toMatchObject({ jsName: "documents", className: "document" });
    expect(dictionary.commands.map((entry) => entry.name)).toEqual(["get", "make", "send", "delete"]);
    expect(dictionary.classes.find((entry) => entry.name === "document")?.properties.map((entry) => entry.name)).toContain("name");
    expect(blockedCommand("run script")).toBe(true);
    expect(() => parseDictionary('<!ENTITY x SYSTEM "file:///etc/passwd"><dictionary/>')).toThrow();
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/System/Applications/Notes.app"))("parses the installed Notes dictionary without following includes", () => {
    const notes = execFileSync("/usr/bin/sdef", ["/System/Applications/Notes.app"], { encoding: "utf8", timeout: 20_000 });
    const standard = readFileSync("/System/Library/ScriptingDefinitions/CocoaStandard.sdef", "utf8");
    const parsed = parseDictionary(notes, standard);
    expect(parsed.classes.find((entry) => entry.name === "application")?.elements.some((entry) => entry.className === "note")).toBe(true);
    expect(parsed.classes.find((entry) => entry.name === "note")?.properties.some((entry) => entry.name === "name")).toBe(true);
  });

  it("keeps terminal, permissions and Vunemi apps outside discovery", () => {
    for (const name of ["Terminal", "System Events", "Script Editor", "Keychain Access", "System Settings", "Shortcuts", "Vunemi", "Tenami", "Database Events", "Folder Actions Setup", "FolderActionsDispatcher"]) {
      expect(blockedApp({ name, bundleId: `example.${name}` })).toBe(true);
    }
    expect(blockedApp({ name: "Safe", bundleId: "com.apple.Terminal" })).toBe(true);
  });

  it("classifies outbound and destructive actions before authorization", () => {
    expect(classifyCommand("get")).toBe("read");
    expect(classifyCommand("make")).toBe("write-local");
    expect(classifyCommand("delete")).toBe("destructive");
    expect(classifyCommand("purge")).toBe("destructive");
    expect(classifyCommand("send")).toBe("outbound");
    expect(tool(tools().list, "app_command")).toMatchObject({ alwaysAsk: true });
    expect(tool(tools().list, "app_dictionary")).toMatchObject({ alwaysAsk: true, allowSessionApproval: true });
    expect(tool(tools().list, "app_get")).toMatchObject({ alwaysAsk: true, allowSessionApproval: true });
  });

  it("keeps JXA property and command receivers bound to their app objects", () => {
    const fake = { name() { return this === fake ? "Demo" : null; }, make() { return this === fake ? "made" : null; } };
    const context = { Application: () => fake, JSON };
    const read = runInNewContext(`${GENERAL_GET}\nrun([${JSON.stringify(JSON.stringify({ appPath: app.path, path: [], property: "name" }))}])`, context);
    expect(JSON.parse(read)).toBe("Demo");
    const made = runInNewContext(`${GENERAL_COMMAND}\nrun([${JSON.stringify(JSON.stringify({ appPath: app.path, command: "make" }))}])`, context);
    expect(JSON.parse(made)).toMatchObject({ result: "made" });
  });

  it("makes a new object through its class, as JXA needs", () => {
    // TextEdit, live: make({new: "document"}) failed with "Can't convert types".
    const made: unknown[] = [];
    const fake = {
      Document(props?: unknown) { return { make: (opts?: unknown) => { made.push({ props, opts }); return "document 1"; } }; },
      make() { throw new Error("Can't convert types."); },
    };
    const input = { appPath: app.path, command: "make", named: { new: { className: "Document" }, withProperties: { text: "hi" } } };
    const out = runInNewContext(`${GENERAL_COMMAND}\nrun([${JSON.stringify(JSON.stringify(input))}])`, { Application: () => fake, JSON });
    expect(JSON.parse(out)).toEqual({ ok: true, result: "document 1" });
    expect(made).toEqual([{ props: { text: "hi" }, opts: undefined }]);
    // With the class's collection known, the new object is pushed onto it.
    const pushed: unknown[] = [];
    const app2 = { make() { throw new Error("Can't convert types."); }, Document: () => ({ kind: "doc" }), documents: Object.assign(() => [], { push: (o: unknown) => pushed.push(o) }) };
    const input2 = { appPath: app.path, command: "make", named: { new: { className: "Document", collection: "documents" } } };
    const out2 = runInNewContext(`${GENERAL_COMMAND}\nrun([${JSON.stringify(JSON.stringify(input2))}])`, { Application: () => app2, JSON });
    expect(JSON.parse(out2)).toEqual({ ok: true, result: "made a new document" });
    expect(pushed).toEqual([{ kind: "doc" }]);
  });

  it("accepts only dictionary-backed paths, properties and commands", async () => {
    const { list, run } = tools();
    const get = tool(list, "app_get");
    await get.run({ app: "Demo", path: [{ element: "documents", name: "Letter" }], property: "text" }, ctx);
    expect(run).toHaveBeenCalledWith(GENERAL_GET, { app: "Demo", appPath: app.path, path: [{ element: "documents", name: "Letter" }], property: "text" });
    run.mockClear();
    await get.run({ app: "Demo", path: [{ element: "application" }, { element: "documents", name: "Letter" }], property: "text" }, ctx);
    expect(run).toHaveBeenCalledWith(GENERAL_GET, { app: "Demo", appPath: app.path, path: [{ element: "documents", name: "Letter" }], property: "text" });
    run.mockClear();
    await expect(get.run({ app: "Demo", path: [{ element: "madeUp" }], property: "text" }, ctx)).rejects.toThrow();
    await expect(get.run({ app: "Demo", path: [{ element: "documents", index: 0, id: "1" }], property: "text" }, ctx)).rejects.toThrow();
    await expect(get.run({ app: "Demo", path: [], property: "madeUp" }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the app as an implicit root and validates the class for make", async () => {
    const { list, run } = tools();
    const command = tool(list, "app_command");
    await command.run({ app: "Demo", command: "make", target: [], params: { new: "document" } }, ctx);
    expect(run).toHaveBeenCalledWith(GENERAL_COMMAND, {
      app: "Demo", appPath: app.path, command: "make", target: undefined, direct: undefined,
      named: { new: { className: "Document", collection: "documents" } },
    });
    run.mockClear();
    await expect(command.run({ app: "Demo", command: "make", params: { new: "application" } }, ctx)).rejects.toThrow();
    await command.run({ app: "Demo", command: "make", target: [{ element: "application" }], params: { new: "document" } }, ctx);
    expect(run).toHaveBeenCalledWith(GENERAL_COMMAND, {
      app: "Demo", appPath: app.path, command: "make", target: undefined, direct: undefined,
      named: { new: { className: "Document", collection: "documents" } },
    });
    run.mockClear();
    await expect(command.run({ app: "Demo", command: "make", target: [{ element: "application" }, { property: "documents" }], params: { new: "document" } }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(GENERAL_COMMAND).toContain("Application(a.appPath)");
  });

  it("shows on the card what a command acts on and with what", async () => {
    const card = await tool(tools().list, "app_command").preview!({ app: "Demo", command: "set", target: [{ element: "documents", index: 0 }], params: { to: "Rapor" } });
    expect(card).toContain("documents");
    expect(card).toContain("Rapor");
  });

  it("rejects script and permanent deletion commands, and passes only JSON data to a fixed template", async () => {
    const { list, run } = tools();
    const command = tool(list, "app_command");
    await expect(command.run({ app: "Demo", command: "do JavaScript", params: { direct: "alert(1)" } }, ctx)).rejects.toThrow();
    await expect(command.run({ app: "Demo", command: "delete" }, ctx)).rejects.toThrow();
    await expect(command.run({ app: "Demo", command: "send", params: { unknown: "x" } }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await command.run({ app: "Demo", command: "send", params: { direct: "hello", to: "me" } }, ctx);
    expect(run).toHaveBeenCalledWith(GENERAL_COMMAND, { app: "Demo", appPath: app.path, command: "send", target: undefined, direct: "hello", named: { to: "me" } });
    expect(GENERAL_COMMAND).toContain("JSON.parse(argv[0])");
    expect(GENERAL_COMMAND).not.toContain("${");
  });
});
