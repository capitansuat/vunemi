/** Parse only the declarative part of an application's scripting dictionary. */

export interface DictionaryMember {
  name: string;
  jsName: string;
  type?: string;
  description?: string;
}

export interface DictionaryElement extends DictionaryMember {
  className: string;
}

export interface DictionaryClass {
  name: string;
  jsName: string;
  plural: string;
  inherits?: string;
  properties: DictionaryMember[];
  elements: DictionaryElement[];
}

export interface DictionaryCommand {
  name: string;
  jsName: string;
  description?: string;
  parameters: DictionaryMember[];
  directTypes: string[];
}

export interface ScriptDictionary {
  suites: { name: string; description?: string }[];
  classes: DictionaryClass[];
  commands: DictionaryCommand[];
}

interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[] }
const MAX_XML = 2_000_000;
const MAX_NODES = 30_000;

function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === "#") {
      const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? "";
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const start = tag.search(/\s/);
  if (start < 0) return result;
  const body = tag.slice(start);
  const attr = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of body.matchAll(attr)) result[match[1]!] = decode(match[2] ?? match[3] ?? "").slice(0, 500);
  return result;
}

/** A small XML tokenizer; declarations and xincludes are ignored, never fetched. */
function xmlTree(xml: string): XmlNode {
  if (xml.length > MAX_XML || /<!ENTITY\b/i.test(xml)) throw new Error("Scripting dictionary is too large or contains entities.");
  const root: XmlNode = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  let count = 0;
  let pos = 0;
  while (pos < xml.length) {
    const open = xml.indexOf("<", pos);
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) throw new Error("Malformed scripting dictionary comment.");
      pos = end + 3;
      continue;
    }
    let end = open + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const ch = xml[end]!;
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (end >= xml.length) throw new Error("Malformed scripting dictionary tag.");
    const raw = xml.slice(open + 1, end).trim();
    pos = end + 1;
    if (!raw || raw[0] === "?" || raw[0] === "!") continue;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim();
      if (stack.length < 2 || stack.at(-1)?.tag !== name) throw new Error("Mismatched scripting dictionary tag.");
      stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const name = body.match(/^[A-Za-z_][\w:.-]*/)?.[0];
    if (!name) throw new Error("Invalid scripting dictionary tag.");
    if (++count > MAX_NODES) throw new Error("Scripting dictionary has too many entries.");
    const node: XmlNode = { tag: name, attrs: attributes(body), children: [] };
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("Unclosed scripting dictionary tag.");
  return root;
}

function children(node: XmlNode, tag: string): XmlNode[] { return node.children.filter((child) => child.tag === tag); }
function descendants(node: XmlNode, tag: string): XmlNode[] {
  const found: XmlNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length) {
    const child = pending.pop()!;
    if (child.tag === tag) found.push(child);
    for (let i = child.children.length - 1; i >= 0; i--) pending.push(child.children[i]!);
  }
  return found;
}

export function jxaName(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  return words.map((word, index) => index ? word[0]!.toUpperCase() + word.slice(1) : word).join("");
}

function plural(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

function member(node: XmlNode): DictionaryMember | null {
  const name = node.attrs.name?.trim();
  if (!name) return null;
  const type = node.attrs.type ?? children(node, "type")[0]?.attrs.type;
  return { name, jsName: jxaName(name), ...(type && { type }), ...(node.attrs.description && { description: node.attrs.description }) };
}

function addUnique<T extends { name: string }>(list: T[], item: T): void {
  if (!list.some((existing) => existing.name.toLowerCase() === item.name.toLowerCase())) list.push(item);
}

/** Include the trusted Cocoa standard dictionary separately, never an app-provided xi:include. */
export function parseDictionary(xml: string, standardXml = ""): ScriptDictionary {
  const sources = standardXml ? [xmlTree(standardXml), xmlTree(xml)] : [xmlTree(xml)];
  const result: ScriptDictionary = { suites: [], classes: [], commands: [] };
  const classes = new Map<string, DictionaryClass>();
  for (const tree of sources) {
    for (const suite of descendants(tree, "suite")) {
      const suiteName = suite.attrs.name;
      if (suiteName) addUnique(result.suites, { name: suiteName, ...(suite.attrs.description && { description: suite.attrs.description }) });
      for (const node of children(suite, "command")) {
        const base = member(node);
        if (!base || blockedCommand(base.name)) continue;
        const parameters = children(node, "parameter").map(member).filter((x): x is DictionaryMember => x !== null);
        const direct = children(node, "direct-parameter")[0];
        const directTypes = direct ? [direct.attrs.type, ...children(direct, "type").map((x) => x.attrs.type)].filter((x): x is string => !!x) : [];
        addUnique(result.commands, { name: base.name, jsName: base.jsName, ...(base.description && { description: base.description }), parameters, directTypes });
      }
      for (const node of suite.children.filter((x) => x.tag === "class" || x.tag === "class-extension")) {
        const name = node.attrs.name ?? node.attrs.extends;
        if (!name) continue;
        const key = name.toLowerCase();
        let found = classes.get(key);
        if (!found) {
          found = { name, jsName: jxaName(name), plural: jxaName(node.attrs.plural ?? plural(name)), ...(node.attrs.inherits && { inherits: node.attrs.inherits }), properties: [], elements: [] };
          classes.set(key, found);
        }
        if (node.attrs.plural) found.plural = jxaName(node.attrs.plural);
        if (node.attrs.inherits) found.inherits = node.attrs.inherits;
        for (const property of children(node, "property")) {
          const info = member(property);
          if (info) addUnique(found.properties, info);
        }
        for (const element of children(node, "element")) {
          const className = element.attrs.type;
          if (!className) continue;
          const target = classes.get(className.toLowerCase());
          const elementName = target?.plural ?? jxaName(plural(className));
          addUnique(found.elements, { name: elementName, jsName: elementName, className });
        }
      }
    }
  }
  result.classes = [...classes.values()];
  // A class may be declared after an element refers to it.
  for (const cls of result.classes) {
    for (const element of cls.elements) element.name = element.jsName = classes.get(element.className.toLowerCase())?.plural ?? element.jsName;
  }
  const resolved = new Set<string>();
  function inherit(cls: DictionaryClass, visiting: Set<string>): void {
    const key = cls.name.toLowerCase();
    if (resolved.has(key) || visiting.has(key)) return;
    visiting.add(key);
    const parent = cls.inherits && classes.get(cls.inherits.toLowerCase());
    if (parent) {
      inherit(parent, visiting);
      for (const item of parent.properties) addUnique(cls.properties, item);
      for (const item of parent.elements) addUnique(cls.elements, item);
    }
    visiting.delete(key);
    resolved.add(key);
  }
  for (const cls of result.classes) inherit(cls, new Set());
  return result;
}

export function blockedCommand(name: string): boolean {
  return /script|javascript/i.test(name);
}

export function classifyCommand(name: string): "read" | "write-local" | "destructive" | "outbound" {
  const first = name.trim().toLowerCase().split(/[\s_-]+/)[0] ?? "";
  if (["get", "count", "exists"].includes(first)) return "read";
  if (["delete", "close", "quit", "empty", "erase", "remove", "clear", "destroy", "purge", "wipe", "reset", "expunge"].includes(first)) return "destructive";
  if (["send", "reply", "forward", "share", "post"].includes(first)) return "outbound";
  return "write-local";
}
