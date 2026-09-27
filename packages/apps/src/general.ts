/** Generic, dictionary-validated Apple Events tools. No model-authored script text. */

import type { ToolDef } from "@ocak/agent-core";
import { t } from "@ocak/i18n";
import { blockedCommand, classifyCommand, type DictionaryClass, type DictionaryMember, type ScriptDictionary } from "./dictionary.js";
import { ScriptableCatalog, type ScriptableApp } from "./catalog.js";
import type { ScriptRunner } from "./runner.js";

const MAX_OUTPUT = 20_000;
const MAX_PATH = 5;
const MAX_VALUE = 4_000;

export interface AppPathStep { element: string; name?: string; index?: number; id?: string }
export interface GeneralToolsOptions {
  catalog: ScriptableCatalog;
  run: ScriptRunner;
}

export const GENERAL_INSTRUCTIONS = `Using other Mac apps:
- Prefer a dedicated tool when one exists. Otherwise call apps_scriptable, then app_dictionary before app_get.
- Keep dictionary requests focused: start with suites, then ask for one class or command.
- app_get follows a structured path. The app is the implicit root: never put "application" in the path. Never guess property, element, or command names; use names from app_dictionary.
- For app_command make, omit target; pass the dictionary class name in params.new. An empty target array also means the app root. Do not invent a path to the application itself.
- App reads need approval for each call unless the user allows this app for the conversation. app_command needs separate approval for every call. Inspect the target and effects first, preview the change, report errors honestly, and verify the result.
- Never ask to run scripts, JavaScript, shell commands, or automation workarounds.`;

export const GENERAL_GET = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application(a.appPath);
  function select(root, path) {
    var current = root;
    for (var i = 0; i < path.length; i++) {
      var step = path[i];
      var collection = current[step.element];
      if (typeof collection !== "function") throw new Error("The application does not expose " + step.element);
      if (step.name !== undefined) current = collection.byName(step.name);
      else if (step.id !== undefined) current = collection.byId(step.id);
      else if (step.index !== undefined) current = collection.at(step.index);
      else current = collection();
    }
    return current;
  }
  function plain(value, depth) {
    if (depth > 3) return "[nested value]";
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.slice(0, 50).map(function (item) { return plain(item, depth + 1); });
    if (typeof value === "string") return value.slice(0, 20000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    try { if (typeof value.name === "function") return String(value.name()).slice(0, 500); } catch (e) {}
    return String(value).slice(0, 500);
  }
  var target = select(app, a.path);
  var value;
  if (a.property) {
    var property = target[a.property];
    if (typeof property !== "function") throw new Error("The application does not expose " + a.property);
    value = target[a.property]();
  } else if (typeof target === "function") value = target();
  else value = target;
  return JSON.stringify(plain(value, 0));
}`;

export const GENERAL_COMMAND = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application(a.appPath);
  function select(root, path) {
    var current = root;
    for (var i = 0; i < path.length; i++) {
      var step = path[i];
      var collection = current[step.element];
      if (typeof collection !== "function") throw new Error("The application does not expose " + step.element);
      if (step.name !== undefined) current = collection.byName(step.name);
      else if (step.id !== undefined) current = collection.byId(step.id);
      else current = collection.at(step.index);
    }
    return current;
  }
  var command = app[a.command];
  if (typeof command !== "function") throw new Error("The application does not implement " + a.command);
  var positional = a.target ? select(app, a.target) : a.direct;
  var named = a.named;
  var result;
  if (named && named.new && typeof named.new === "object" && named.new.className) {
    var constructor = app[named.new.className];
    if (typeof constructor !== "function") throw new Error("The application cannot create " + named.new.className);
    // JXA can send neither the class nor its name as make's "new" (TextEdit: "Can't convert types").
    // The class builds the object, with any properties, and the object makes itself.
    var built = named.withProperties && typeof named.withProperties === "object" ? constructor(named.withProperties) : constructor();
    // Apple's way: push the new object onto the app's collection of that class.
    var collection = positional === undefined && named.new.collection ? app[named.new.collection] : null;
    if (collection && typeof collection.push === "function") {
      collection.push(built);
      return JSON.stringify({ ok: true, result: "made a new " + named.new.className.toLowerCase() });
    }
    result = positional !== undefined ? built.make({ at: positional }) : built.make();
    return JSON.stringify({ ok: true, result: result === undefined || result === null ? null : String(result).slice(0, 1000) });
  }
  if (positional !== undefined && named) result = app[a.command](positional, named);
  else if (positional !== undefined) result = app[a.command](positional);
  else if (named) result = app[a.command](named);
  else result = app[a.command]();
  if (result === undefined || result === null) return JSON.stringify({ok:true});
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") return JSON.stringify({ok:true,result:result});
  return JSON.stringify({ok:true,result:String(result).slice(0,1000)});
}`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function findClass(dictionary: ScriptDictionary, name: string): DictionaryClass {
  const found = dictionary.classes.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`The class ${name} is not in this application's dictionary.`);
  return found;
}

function findMember(list: readonly DictionaryMember[], name: string, kind: string): DictionaryMember {
  const found = list.find((entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.jsName.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`${kind} ${name} is not in the scripting dictionary.`);
  return found;
}

function validatePath(dictionary: ScriptDictionary, raw: unknown, allowCollection: boolean): { path: Record<string, unknown>[]; finalClass: DictionaryClass; collection: boolean } {
  if (!Array.isArray(raw) || raw.length > MAX_PATH + 1) throw new Error(`Path must be an array of at most ${MAX_PATH} elements after the optional app root.`);
  const requested = raw[0] && typeof raw[0] === "object" && !Array.isArray(raw[0])
    && String((raw[0] as Record<string, unknown>).element ?? "").toLowerCase() === "application"
    && Object.keys(raw[0] as Record<string, unknown>).length === 1 ? raw.slice(1) : raw;
  if (requested.length > MAX_PATH) throw new Error(`Path must contain at most ${MAX_PATH} elements.`);
  let current = findClass(dictionary, "application");
  const path: Record<string, unknown>[] = [];
  let collection = false;
  for (const [index, entry] of requested.entries()) {
    const step = object(entry);
    const name = string(step.element, "element");
    const element = findMember(current.elements, name, "Element") as DictionaryMember & { className: string };
    const selectors = [step.name, step.id, step.index].filter((value) => value !== undefined);
    if (selectors.length > 1) throw new Error("Use only one of name, id, or index per path step.");
    collection = selectors.length === 0;
    if (collection && (!allowCollection || index !== requested.length - 1)) throw new Error("Only the last read path step may be a collection.");
    const safe: Record<string, unknown> = { element: element.jsName };
    if (step.name !== undefined) safe.name = string(step.name, "name", 500);
    if (step.id !== undefined) safe.id = string(step.id, "id", 500);
    if (step.index !== undefined) {
      if (!Number.isInteger(step.index) || (step.index as number) < 0 || (step.index as number) > 999) throw new Error("index must be between 0 and 999.");
      safe.index = step.index;
    }
    path.push(safe);
    current = findClass(dictionary, element.className);
  }
  return { path, finalClass: current, collection };
}

function value(raw: unknown, depth = 0): unknown {
  if (depth > 3) throw new Error("Command values are nested too deeply.");
  if (typeof raw === "string") return string(raw, "value", MAX_VALUE);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw) && raw.length <= 50) return raw.map((item) => value(item, depth + 1));
  throw new Error("Only strings, numbers, booleans, and short arrays of them are supported as command values.");
}

function bounded(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n[output truncated]`;
}

async function permitted(opts: GeneralToolsOptions, name: unknown): Promise<{ app: ScriptableApp; dictionary: ScriptDictionary }> {
  const app = await opts.catalog.find(string(name, "app"));
  return { app, dictionary: await opts.catalog.dictionary(app) };
}

function appApprovalScope(args: Record<string, unknown>): string | undefined {
  const app = args.app;
  return typeof app === "string" && app.trim() ? `mac-app:${app.trim().toLowerCase()}` : undefined;
}

function topicText(dictionary: ScriptDictionary, topic?: string): string {
  if (!topic) {
    const suites = dictionary.suites.map((suite) => suite.name).join(", ");
    const classes = dictionary.classes.slice(0, 35).map((entry) => entry.name).join(", ");
    const commands = dictionary.commands.slice(0, 35).map((entry) => entry.name).join(", ");
    return bounded(`Suites: ${suites}\nClasses (first 35): ${classes}\nCommands (first 35): ${commands}\nAsk for one class or command as topic to see its details.`).slice(0, 8_000);
  }
  const cls = dictionary.classes.find((entry) => entry.name.toLowerCase() === topic.toLowerCase());
  if (cls) return bounded(`Class ${cls.name}\nProperties: ${cls.properties.map((item) => `${item.name}${item.type ? ` (${item.type})` : ""}`).join(", ")}\nElements: ${cls.elements.map((item) => `${item.name} → ${item.className}`).join(", ")}`).slice(0, 8_000);
  const command = dictionary.commands.find((entry) => entry.name.toLowerCase() === topic.toLowerCase());
  if (command) return bounded(`Command ${command.name}\nDirect parameter types: ${command.directTypes.join(", ") || "none"}\nNamed parameters: ${command.parameters.map((item) => `${item.name}${item.type ? ` (${item.type})` : ""}`).join(", ")}\n${command.description ?? ""}`).slice(0, 8_000);
  throw new Error(`No class or command named ${topic} is in this dictionary.`);
}

export function createGeneralTools(opts: GeneralToolsOptions): ToolDef[] {
  return [
    {
      name: "apps_scriptable",
      description: "List installed Mac apps with scripting dictionaries. Listing does not open app data; reading a selected app needs approval for this user request.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      untrustedOutput: true,
      async run() {
        const apps = await opts.catalog.list();
        return bounded(apps.map((app) => `- ${app.name} (${app.bundleId})`).join("\n") || "No scriptable apps were found.");
      },
    },
    {
      name: "app_dictionary",
      description: "Read a bounded summary of one Mac app's scripting dictionary after approval. Use topic for one class or command.",
      parameters: { type: "object", properties: { app: { type: "string" }, topic: { type: "string" } }, required: ["app"] },
      actionClass: "read",
      alwaysAsk: true,
      approvalScope: appApprovalScope,
      allowSessionApproval: true,
      preview: async (args) => t("connectors.apps.requestPreview", { app: String(args.app ?? "") }),
      untrustedOutput: true,
      async run(args) {
        const { app, dictionary } = await permitted(opts, args.app);
        return `${app.name} (${app.bundleId})\n${topicText(dictionary, args.topic === undefined ? undefined : string(args.topic, "topic"))}`;
      },
    },
    {
      name: "app_get",
      description: "Read a dictionary-validated property or collection after approval. Each path step names an element and optionally a name, id, or zero-based index.",
      parameters: { type: "object", properties: { app: { type: "string" }, path: { type: "array", items: { type: "object" } }, property: { type: "string" } }, required: ["app", "path"] },
      actionClass: "read",
      alwaysAsk: true,
      approvalScope: appApprovalScope,
      allowSessionApproval: true,
      preview: async (args) => t("connectors.apps.requestPreview", { app: String(args.app ?? "") }),
      untrustedOutput: true,
      ephemeral: true,
      async run(args) {
        const { app, dictionary } = await permitted(opts, args.app);
        const checked = validatePath(dictionary, args.path, true);
        if (checked.collection && args.property !== undefined) throw new Error("A collection cannot have a property; select one item first.");
        const property = args.property === undefined ? undefined : findMember(checked.finalClass.properties, string(args.property, "property"), "Property").jsName;
        if (!property && checked.path.length === 0) throw new Error("Choose a property or a path to read.");
        const result = await opts.run(GENERAL_GET, { app: app.name, appPath: app.path, path: checked.path, property });
        if (result === null) return `The dictionary contains ${property ?? "this item"}, but ${app.name} returned no value.`;
        return bounded(result);
      },
    },
    {
      name: "app_command",
      description: "Run one dictionary-validated Mac app command. Every call needs the user's approval. Target is a structured object path; params may contain direct and named primitive values.",
      parameters: { type: "object", properties: { app: { type: "string" }, command: { type: "string" }, target: { type: "array", items: { type: "object" } }, params: { type: "object" } }, required: ["app", "command"] },
      actionClass: "write-local",
      classify: (args) => classifyCommand(String(args.command ?? "")),
      alwaysAsk: true,
      // The card shows what the command acts on and with what, not only its name.
      preview: async (args) => {
        const detail = [args.target === undefined ? "" : JSON.stringify(args.target), args.params === undefined ? "" : JSON.stringify(args.params)].filter(Boolean).join(" ");
        const command = `${String(args.command ?? "")}${detail ? ` ${detail.length > 240 ? `${detail.slice(0, 239)}…` : detail}` : ""}`;
        return t("connectors.apps.commandPreview", { app: String(args.app ?? ""), command });
      },
      async run(args) {
        const { app, dictionary } = await permitted(opts, args.app);
        const commandName = string(args.command, "command");
        if (blockedCommand(commandName)) throw new Error("Script and JavaScript commands are off limits.");
        if (/^(delete|empty|erase|remove|clear|destroy|purge|wipe|reset|expunge)(\b|$)/i.test(commandName)) throw new Error("Commands that can permanently delete data are unavailable.");
        const command = dictionary.commands.find((entry) => entry.name.toLowerCase() === commandName.toLowerCase() || entry.jsName.toLowerCase() === commandName.toLowerCase());
        if (!command || blockedCommand(command.name)) throw new Error(`Command ${commandName} is not available in this dictionary.`);
        const checkedTarget = args.target === undefined ? [] : validatePath(dictionary, args.target, false).path;
        const target = checkedTarget.length ? checkedTarget : undefined;
        const params = args.params === undefined ? {} : object(args.params);
        const named: Record<string, unknown> = {};
        let direct: unknown;
        for (const [name, raw] of Object.entries(params)) {
          if (name === "direct") {
            if (target) throw new Error("Use target or direct, not both.");
            if (!command.directTypes.length) throw new Error("This command has no direct parameter.");
            direct = value(raw);
          } else {
            const parameter = findMember(command.parameters, name, "Parameter");
            if (command.name.toLowerCase() === "make" && parameter.name.toLowerCase() === "new" && parameter.type === "type") {
              const cls = findClass(dictionary, string(raw, "new"));
              if (cls.name.toLowerCase() === "application") throw new Error("An application cannot be created.");
              named[parameter.jsName] = { className: cls.jsName[0]!.toUpperCase() + cls.jsName.slice(1), collection: cls.plural };
            } else named[parameter.jsName] = value(raw);
          }
        }
        if (JSON.stringify({ target, direct, named }).length > 8_000) throw new Error("Command arguments are too large.");
        const result = await opts.run(GENERAL_COMMAND, { app: app.name, appPath: app.path, command: command.jsName, target, direct, named: Object.keys(named).length ? named : undefined });
        return bounded(result);
      },
    },
  ];
}
