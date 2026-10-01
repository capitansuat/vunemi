import type { ChoiceCard, OptionCard, VerifiedFact } from "./events.js";
import type { ToolDef } from "./tools.js";

export interface ChoiceAnswer {
  text: string;
  index?: number;
}

export interface ChoiceEvidence {
  pages: { url: string; text: string }[];
  local: string[];
}

/** A plain comparison table can become cards without another model round trip. */
export function tableChoiceInput(text: string): { items: { title: string; price?: string; facts: { label: string; value: string }[] }[] } | null {
  const lines = text.split("\n");
  const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  for (let at = 0; at < lines.length - 3; at++) {
    if (!/^\s*\|/.test(lines[at] ?? "")) continue;
    const headers = cells(lines[at]!);
    if (headers.length < 2 || headers.length > 8 || headers.some((cell) => !cell)) continue;
    const separator = cells(lines[at + 1] ?? "");
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows: string[][] = [];
    for (let row = at + 2; row < lines.length && /^\s*\|/.test(lines[row]!) && rows.length < 7; row++) {
      const values = cells(lines[row]!);
      if (values.length !== headers.length || !values[0]) break;
      rows.push(values);
    }
    if (rows.length < 2 || rows.length > 6 || new Set(rows.map((row) => row[0])).size !== rows.length) continue;
    const items = rows.map((row) => {
      const facts: { label: string; value: string }[] = [];
      let price: string | undefined;
      for (let col = 1; col < headers.length; col++) {
        const value = row[col]!;
        if (!value || value === "—" || value === "-") continue;
        if (/^(?:price|fiyat|ücret|fare|cost)$/iu.test(headers[col]!) && !price) price = value;
        else facts.push({ label: headers[col]!, value });
      }
      return { title: row[0]!, ...(price && { price }), facts };
    });
    return { items };
  }
  return null;
}

const string = (value: unknown, limit: number): string => {
  if (typeof value !== "string") return "";
  // Cards are data, never markup or model-authored UI.
  const plain = value.replace(/<[^>]*>/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(plain).slice(0, limit).join("");
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Comparison means only that the displayed value occurred in the observed output. */
export function valueSeen(value: string, output: string): boolean {
  const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase()
    .replace(/(\d)[.,\s](?=\d{3}(?:\D|$))/g, "$1")
    .replace(/\s+/g, " ").trim();
  const needle = normalize(value);
  const haystack = normalize(output);
  if (!needle) return false;
  const word = /[\p{L}\p{N}]/u;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at > 0 ? haystack[at - 1]! : "";
    const after = haystack[at + needle.length] ?? "";
    if ((!word.test(needle[0]!) || !word.test(before)) &&
        (!word.test(needle.at(-1)!) || !word.test(after))) return true;
  }
  return false;
}

function source(raw: unknown, evidence: ChoiceEvidence): string | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = "";
    return evidence.pages.some((page) => {
      try {
        const opened = new URL(page.url);
        opened.hash = "";
        return opened.href === url.href;
      } catch { return false; }
    }) ? url.href : undefined;
  } catch { return undefined; }
}

function fact(label: string, value: string, sourceUrl: string | undefined, evidence: ChoiceEvidence): VerifiedFact {
  const page = sourceUrl && evidence.pages.some((entry) => {
    try {
      const url = new URL(entry.url);
      url.hash = "";
      return url.href === sourceUrl && valueSeen(value, entry.text);
    } catch { return false; }
  });
  return { label, value, status: page ? "page" : evidence.local.some((text) => valueSeen(value, text)) ? "local" : "unverified" };
}

/** Validate once in the agent, before any card or wait is created. */
export function prepareChoice(name: string, input: unknown, evidence: ChoiceEvidence): { card: ChoiceCard } | { error: string } {
  const args = object(input);
  if (!args) return { error: "Expected a JSON object." };
  if (name === "ask_choice") {
    const question = string(args.question, 200);
    const options = Array.isArray(args.options) ? args.options.slice(0, 5).map((value) => string(value, 80)).filter(Boolean) : [];
    if (!question || options.length < 2 || new Set(options).size !== options.length) return { error: "Give a question and 2 to 5 distinct nonempty choices." };
    return { card: { kind: "choice", question, options, allowOther: args.allowOther !== false } };
  }
  if (name !== "present_options") return { error: "Unknown choice tool." };
  if (!Array.isArray(args.items) || args.items.length < 2) return { error: "Give 2 to 6 option cards." };
  const items: OptionCard[] = [];
  for (const raw of args.items.slice(0, 6)) {
    const item = object(raw);
    if (!item) return { error: "Each card must be an object." };
    const title = string(item.title, 80);
    if (!title) return { error: "Each card needs a title." };
    const sourceUrl = source(item.sourceUrl, evidence);
    const facts: VerifiedFact[] = [];
    if (item.facts !== undefined && !Array.isArray(item.facts)) return { error: "Facts must be an array." };
    for (const rawFact of (item.facts as unknown[] | undefined ?? []).slice(0, 6)) {
      const entry = object(rawFact);
      const label = string(entry?.label, 30);
      const value = string(entry?.value, 80);
      if (!label || !value) return { error: "Each fact needs a label and value." };
      facts.push(fact(label, value, sourceUrl, evidence));
    }
    const price = string(item.price, 80);
    const view = string(item.view, 200);
    items.push({ title, facts, ...(price && { price: fact("price", price, sourceUrl, evidence) }), ...(view && { view }), ...(sourceUrl && { sourceUrl }) });
  }
  const intro = string(args.intro, 200);
  return { card: { kind: "options", items, ...(intro && { intro }) } };
}

/** The runtime handles these calls; the registry supplies schemas to small models. */
export function choiceTools(): ToolDef[] {
  return [
    {
      name: "ask_choice",
      description: "Ask one short question with 2 to 5 choices, then wait for the user. Use only when the answer changes your next step.",
      actionClass: "read",
      parameters: { type: "object", properties: {
        question: { type: "string" }, options: { type: "array", items: { type: "string" } }, allowOther: { type: "boolean" },
      }, required: ["question", "options"] },
      run: () => { throw new Error("ask_choice must be handled by the agent runtime"); },
    },
    {
      name: "present_options",
      description: "Show 2 to 6 compared options as cards, then wait for the user. Facts must be values you read. Put your judgement only in view.",
      actionClass: "read",
      parameters: { type: "object", properties: {
        intro: { type: "string" },
        items: { type: "array", items: { type: "object", properties: {
          title: { type: "string" }, price: { type: "string" },
          facts: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
          view: { type: "string" }, sourceUrl: { type: "string" },
        }, required: ["title", "facts"] } },
      }, required: ["items"] },
      run: () => { throw new Error("present_options must be handled by the agent runtime"); },
    },
  ];
}
