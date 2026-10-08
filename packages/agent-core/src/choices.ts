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

const PRICE_LABEL = /^(?:(?:approx\.?|estimated|tahmini|yaklaşık)\s+)?(?:price|fiyat|ücret|fare|cost)(?:\s+(?:range|aralığı))?$/iu;

/** Buttons the card holds. The model is told five; live it wrote out seven, and dropping two unsaid is worse than a longer row. */
const MAX_OPTIONS = 8;

/**
 * A question that asks which of several things, in the languages the app
 * speaks. Under a list it tells a question about the items from an offer,
 * whose answers are yes and no.
 */
const WHICH = /(?<!\p{L})(?:which|hangi\p{L}*|welche[rsnm]?|(?:le|la|les)?quel(?:le)?s?|cu[aá]l(?:es)?|qual[ei]?|quais|как(?:ой|ая|ое|ие|ую|ого|им|ом|ими|их)|котор\p{L}+)(?!\p{L})|哪|どれ|どちら|どの(?!よう|くらい|ぐらい)|어느|어떤/iu;

/**
 * A question the model wrote out as a plain list instead of calling
 * ask_choice: short list items with a question right before or right after
 * them. Live, the same request gave buttons once and a numbered list the
 * next time. An item that opens in bold gives only that name to its
 * button; its description stays in the text above. An item that only says
 * "something else" becomes the free answer the card already allows.
 *
 * A question after the list is taken more narrowly: one short line, five
 * options at most, and it has to ask which of them, since a list that ends
 * in a question is as often an answer with an offer under it. Measured
 * live, "Want me to try more?" under three slogans made the slogans its
 * buttons, and the task waited on them. A question before the list is the task
 * asking, and measured live it came in more shapes than that: up to seven
 * options, a lead-in between the question and the list ("For example:"),
 * the lead-in on the question's own line, and a sentence or two after.
 */
export function listChoiceInput(text: string): { question: string; options: string[]; allowOther: boolean } | null {
  const plain = (line: string): string => line.replace(/\*\*|__|`/g, "").trim();
  const asks = (line: string): boolean => /[?？]\s*$/.test(plain(line));
  // "1.", "-", and the lettered "A)" or "**A)**" of a quiz.
  const item = /^(?:\d{1,2}[.)]|[-*•]|(?:\*\*)?[A-Ha-h][.)](?:\*\*)?)\s+(.+)$/;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const said = line.trim();
    if (!said) continue;
    // An indented line under an item is the rest of that item.
    if (/^(?: {2,}|\t)/.test(line) && !item.test(said) && lines.length > 0 && item.test(lines.at(-1)!)) continue;
    lines.push(said);
  }
  let end = lines.length;
  while (end > 0 && !item.test(lines[end - 1]!)) end--;
  let start = end;
  while (start > 0 && item.test(lines[start - 1]!)) start--;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  if (end - start < 2) return null;
  // More than a sentence or two before the list is an answer, not a question.
  if (before.join(" ").length > 300) return null;
  const closes = after.length === 1 && after[0]!.length <= 120 && asks(after[0]!) && WHICH.test(plain(after[0]!));
  /** The question a line asks: all of it, or what comes before a lead-in such as "My options:". */
  const asked = (line: string | undefined): string => {
    if (!line) return "";
    const said = plain(line);
    return asks(said) ? said : /^(.*[?？])[^?？]{0,40}:$/.exec(said)?.[1] ?? "";
  };
  const above = before.at(-1);
  const leadIn = above !== undefined && plain(above).length <= 60 && /:$/.test(plain(above));
  const question = closes ? plain(after[0]!) : after.length <= 3 && after.join(" ").length <= 400 ? asked(above) || (leadIn ? asked(before.at(-2)) : "") : "";
  if (!question || question.length > 200) return null;
  const label = (line: string): string => {
    const body = item.exec(line)![1]!;
    const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(body);
    return plain(bold ? bold[1]! : body).replace(/\s*:$/, "");
  };
  const all = lines.slice(start, end).map(label);
  // "🤖 Other" is still the other.
  const other = /^(?:something else|other|another|none of these|not sure|başka(?: bir (?:şey|tür))?|diğer|hiçbiri|emin değilim)\b/iu;
  const options = all.filter((option) => !other.test(option.replace(/^[^\p{L}\p{N}]+/u, "")));
  if (options.length < 2 || options.length > (closes ? 5 : MAX_OPTIONS) || options.some((option) => !option || option.length > 80) || new Set(options).size !== options.length) return null;
  return { question, options, allowOther: true };
}

/** The first Markdown table in a text: its header cells and its rows of the same width. */
function firstTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.split("\n");
  const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  for (let at = 0; at < lines.length - 3; at++) {
    if (!/^\s*\|/.test(lines[at] ?? "")) continue;
    const headers = cells(lines[at]!);
    if (headers.length < 2 || headers.length > 8 || headers.slice(1).some((cell) => !cell)) continue;
    const separator = cells(lines[at + 1] ?? "");
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows: string[][] = [];
    for (let row = at + 2; row < lines.length && /^\s*\|/.test(lines[row]!) && rows.length < 20; row++) {
      const values = cells(lines[row]!);
      if (values.length !== headers.length || !values[0]) break;
      rows.push(values);
    }
    if (rows.length >= 2) return { headers, rows };
  }
  return null;
}

/** The text lays options out in a table, whichever way round. */
export function comparisonTable(text: string): boolean {
  return firstTable(text) !== null;
}

/** What the first column of a table is called when its rows are features and its columns the options. */
const FEATURE_LABEL = /^(?:features?|criteri(?:a|on)|aspects?|factors?|attributes?|propert(?:y|ies)|specs?|categor(?:y|ies)|özellik(?:ler)?|kriter(?:ler)?|ölçüt(?:ler)?|kategori)$/iu;

/**
 * A plain comparison table can become cards without another model round
 * trip, when it is certain which way round it runs. Rows are the options
 * when a column is the price, or when the request names them. Columns are
 * the options when the first column is headed as the features, or the
 * request names the columns. Measured live, "| Feature | 13-inch | 15-inch |"
 * read row by row came out as cards named Weight and Closed depth; a table
 * that says neither goes back to the model.
 */
export function tableChoiceInput(text: string, goal = ""): { items: { title: string; price?: string; facts: { label: string; value: string }[] }[] } | null {
  const table = firstTable(text);
  if (!table) return null;
  const bare = (cell: string): string => cell.replace(/\*\*|__|`/g, "").trim();
  // A column that only counts the rows ("#", 1, 2, 3) names nothing.
  const counted = /^(?:#|no\.?|№)$/i.test(bare(table.headers[0]!)) && table.headers.length > 2 && table.rows.every((row, at) => bare(row[0]!) === String(at + 1));
  const headers = table.headers.slice(counted ? 1 : 0).map(bare);
  const rows = table.rows.map((row) => row.slice(counted ? 1 : 0).map(bare));
  const distinct = (names: string[]): boolean => names.every(Boolean) && new Set(names).size === names.length;
  const asked = goal.toLocaleLowerCase();
  const named = (names: string[]): boolean => names.filter((name) => asked.includes(name.toLocaleLowerCase())).length >= 2;
  const across = headers.slice(1);
  const down = rows.map((row) => row[0]!);
  const byRow = Boolean(headers[0]) && rows.length <= 6 && distinct(down);
  const byColumn = across.length >= 2 && across.length <= 6 && rows.length <= 12 && distinct(across);
  const empty = (value: string | undefined): boolean => !value || value === "—" || value === "-";
  if (byRow && (headers.some((header) => PRICE_LABEL.test(header)) || (named(down) && !named(across)))) {
    return { items: rows.map((row) => {
      const facts: { label: string; value: string }[] = [];
      let price: string | undefined;
      for (let col = 1; col < headers.length; col++) {
        const value = row[col];
        if (empty(value)) continue;
        if (PRICE_LABEL.test(headers[col]!) && !price) price = value;
        else facts.push({ label: headers[col]!, value: value! });
      }
      return { title: row[0]!, ...(price && { price }), facts };
    }) };
  }
  if (byColumn && (!headers[0] || FEATURE_LABEL.test(headers[0]) || named(across))) {
    return { items: across.map((title, at) => {
      const facts: { label: string; value: string }[] = [];
      let price: string | undefined;
      for (const row of rows) {
        const value = row[at + 1];
        if (empty(value)) continue;
        if (PRICE_LABEL.test(row[0]!) && !price) price = value;
        else facts.push({ label: row[0]!, value: value! });
      }
      return { title, ...(price && { price }), facts };
    }) };
  }
  return null;
}

/**
 * A turn that is only a short question to the user, with no answers
 * written out. Measured live, one question in seven that the user had
 * asked for came this way, without buttons.
 */
export function bareQuestion(text: string): boolean {
  const said = text.replace(/\*\*|__|`/g, "").trim();
  if (said.length < 8 || said.length > 240 || !/[?？]$/.test(said)) return false;
  return !said.split("\n").some((line) => /^\s*(?:\d{1,2}[.)]|[-*•]|\|)\s*\S/.test(line));
}

/** Cards are data, never markup or model-authored UI. */
const plain = (value: unknown): string => typeof value !== "string" ? "" : Array.from(
  value.replace(/<[^>]*>/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 400).join("");

/** Cut to fit a card, with a mark where: a sentence that just stops reads as a mistake. */
const clip = (text: string, limit: number): string => {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
};

const string = (value: unknown, limit: number): string => clip(plain(value), limit);

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

/**
 * A fact that gives several values at once ("658 236 (city) / 3 353 000
 * (metro)") was read when each part was. Live, a model merged two figures
 * it had just read into one line, and the line as a whole was on no page.
 */
function seen(value: string, output: string): boolean {
  if (valueSeen(value, output)) return true;
  const parts = value.split(/\s*[;|·()]\s*(?:\/\s+)?|\s+\/\s+/u).filter(Boolean);
  return parts.length > 1 && parts.every((part) => valueSeen(part, output));
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

/**
 * For a card without a source: the page read in this run that shows the
 * most of its values, the latest when several do. A small model fills in
 * the facts and leaves the link out; live, every value then read "not
 * found" though the page it had just read showed them.
 */
function readSource(item: Record<string, unknown>, evidence: ChoiceEvidence): string | undefined {
  const values = [item.price, ...(Array.isArray(item.facts) ? item.facts.map((f) => object(f)?.value) : [])]
    .map(plain).filter(Boolean);
  let best: { url: string; seen: number } | undefined;
  for (const page of evidence.pages) {
    const count = values.filter((value) => seen(value, page.text)).length;
    if (count > 0 && (!best || count >= best.seen)) best = { url: page.url, seen: count };
  }
  return best && source(best.url, evidence);
}

/** Checked as written in full; shown cut to fit. */
function fact(label: string, value: string, sourceUrl: string | undefined, evidence: ChoiceEvidence): VerifiedFact {
  const page = sourceUrl && evidence.pages.some((entry) => {
    try {
      const url = new URL(entry.url);
      url.hash = "";
      return url.href === sourceUrl && seen(value, entry.text);
    } catch { return false; }
  });
  return { label, value: clip(value, 80), status: page ? "page" : evidence.local.some((text) => seen(value, text)) ? "local" : "unverified" };
}

/** Validate once in the agent, before any card or wait is created. */
export function prepareChoice(name: string, input: unknown, evidence: ChoiceEvidence): { card: ChoiceCard } | { error: string } {
  const args = object(input);
  if (!args) return { error: "Expected a JSON object." };
  if (name === "ask_choice") {
    const question = string(args.question, 200);
    const options = Array.isArray(args.options) ? args.options.slice(0, MAX_OPTIONS).map((value) => string(value, 80)).filter(Boolean) : [];
    if (!question || options.length < 2 || new Set(options).size !== options.length) return { error: `Give a question and 2 to ${MAX_OPTIONS} distinct nonempty choices.` };
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
    // A card that names no source is checked against the pages read in this run.
    const sourceUrl = item.sourceUrl === undefined || item.sourceUrl === "" ? readSource(item, evidence) : source(item.sourceUrl, evidence);
    const facts: VerifiedFact[] = [];
    let price = plain(item.price);
    if (item.facts !== undefined && !Array.isArray(item.facts)) return { error: "Facts must be an array." };
    for (const rawFact of (item.facts as unknown[] | undefined ?? []).slice(0, 6)) {
      const entry = object(rawFact);
      const label = string(entry?.label, 30);
      const value = plain(entry?.value);
      if (!label || !value) return { error: "Each fact needs a label and value." };
      // A price filed under the facts is still the card's price; shown twice, it was compared twice.
      if (!price && PRICE_LABEL.test(label)) price = value;
      else facts.push(fact(label, value, sourceUrl, evidence));
    }
    const view = string(item.view, 200);
    items.push({ title, facts, ...(price && { price: fact("price", price, sourceUrl, evidence) }), ...(view && { view }), ...(sourceUrl && { sourceUrl }) });
  }
  const intro = string(args.intro, 200);
  // Dinner ideas, names for a project: nothing to match them against, and "not found on the page" under each would be untrue.
  const unchecked = evidence.pages.length === 0 && evidence.local.length === 0;
  return { card: { kind: "options", items, ...(intro && { intro }), ...(unchecked && { unchecked }) } };
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
      description: "Show 2 to 6 compared options as cards, then wait for the user. Each fact: one value you read, as written. Put your judgement only in view.",
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
