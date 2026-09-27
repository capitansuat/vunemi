/**
 * Markdown to blocks, for the chat's own small renderer (components/
 * Markdown.tsx). Kept apart from React so it can be tested.
 */

/** GFM's separator row: `| --- | :-: | --: |`, outer pipes optional. */
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isRow = (line: string) => line.trim().startsWith("|") && line.trim().length > 1;

const startsTable = (lines: string[], i: number) =>
  isRow(lines[i]!) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!);

/** Splits a row on unescaped pipes, dropping the outer ones. */
function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : "left";
}

export type Align = "left" | "center" | "right";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++; // closing fence (or EOF while streaming)
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(lines[i++]!.replace(re, ""));
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    // A table needs its separator row to be one: until that line has
    // streamed in, the header stays a paragraph, then becomes a table.
    if (isRow(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push({ kind: "table", head, align, rows });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|>)/.test(lines[i]!) && !startsTable(lines, i)) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }
  return blocks;
}

const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", "\\circ": "°" };
const SYMBOLS: Record<string, string> = {
  rightarrow: "→", to: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", times: "×", cdot: "·", div: "÷", pm: "±",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", approx: "≈", degree: "°", circ: "°", infty: "∞", alpha: "α", beta: "β",
  gamma: "γ", delta: "δ", Delta: "Δ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", theta: "θ", omega: "ω", sqrt: "√",
};

/** A sub- or superscript in Unicode, or as it was when a character has no such form. */
function script(body: string, map: Record<string, string>, mark: string): string {
  if (map[body]) return map[body];
  const chars = [...body];
  return chars.every((c) => map[c]) ? chars.map((c) => map[c]).join("") : `${mark}${body}`;
}

function mathToText(tex: string): string {
  return tex
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\^\{?\\circ\}?/g, "°")
    .replace(/\\([A-Za-z]+)/g, (m, name: string) => SYMBOLS[name] ?? m)
    .replace(/_\{([^{}]*)\}|_(\S)/g, (_m, a: string | undefined, b: string | undefined) => script(a ?? b!, SUB, "_"))
    .replace(/\^\{([^{}]*)\}|\^(\S)/g, (_m, a: string | undefined, b: string | undefined) => script(a ?? b!, SUP, "^"))
    .replace(/\\[,;: !]/g, " ")
    .replace(/[{}]/g, "")
    .trim();
}

/**
 * The chat has no math renderer: LaTeX a model writes ($\text{CO}_2$) is
 * shown as the text it stands for (CO₂). Dollar amounts are left alone; only
 * a span holding LaTeX markup counts as math.
 */
export function plainMath(text: string): string {
  return text.replace(/\$\$([^$\n]+)\$\$|\$([^$\n]{1,200}?)\$/g, (whole, display: string | undefined, inlineTex: string | undefined) => {
    const tex = display ?? inlineTex ?? "";
    return /[\\_^{}]/.test(tex) ? mathToText(tex) : whole;
  });
}
