/**
 * A page's main content as Markdown, for page_read. The page is read where it
 * is, in one evaluate: CONTENT_SCRIPT picks the part that holds the content
 * (not the menus, header, footer, side columns or cookie dialogs around it)
 * and hands back a small tree; markdownOf turns that tree into Markdown here,
 * where it can be tested without a browser. Our own code: no dependency.
 */

export type ContentNode =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; kids: ContentNode[] }
  | { t: "p" | "li" | "strong" | "em" | "td" | "th"; kids: ContentNode[] }
  | { t: "ul" | "ol" | "tr" | "table"; kids: ContentNode[] }
  | { t: "a"; href: string; kids: ContentNode[] }
  | { t: "img"; alt: string }
  | { t: "br" }
  | { t: "text"; text: string };

/** Between the content page_read shows and the whole page text it keeps for output_search. */
export const WHOLE_PAGE_MARK = "\n\n[Whole page text, for output_search:]\n";

/** page_read shows at most this much, and never the whole page text after the mark. */
export const CONTENT_SHOWN = 6_000;

/** Which part of the page was read: its <main>, its <article>, the densest block, or the body. */
export type Reader = "main" | "article" | "dense" | "text";

const BLOCKS = new Set(["h", "p", "ul", "ol", "table", "li", "tr"]);

/** A node with children, whatever its kind. */
type Parent = { t: string; kids: ContentNode[] };

/** Inline text of nodes; a line break stays a line break, other whitespace collapses. */
function inline(kids: readonly ContentNode[]): string {
  const out = kids.map(inlineOf).join("");
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, all) => line !== "" || (i > 0 && i < all.length - 1))
    .join("\n")
    .trim();
}

function inlineOf(n: ContentNode): string {
  switch (n.t) {
    case "text":
      return n.text.replace(/\s+/g, " ");
    case "br":
      return "\n";
    case "img":
      return n.alt.trim() ? ` ${n.alt.trim()} ` : "";
    case "strong":
    case "em": {
      const inner = inline(n.kids);
      if (!inner) return "";
      const mark = n.t === "strong" ? "**" : "*";
      return ` ${mark}${inner}${mark} `;
    }
    case "a": {
      const inner = inline(n.kids);
      if (!inner) return "";
      return /^https?:\/\//i.test(n.href) ? ` [${inner}](${n.href}) ` : ` ${inner} `;
    }
    default:
      // A block met inside a line (a list inside a paragraph): its text, on its own line.
      return `\n${markdownOf([n])}\n`;
  }
}

function list(node: Parent, depth: number): string {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  let n = 0;
  for (const item of node.kids) {
    if (item.t !== "li") continue;
    n++;
    const own = item.kids.filter((k) => k.t !== "ul" && k.t !== "ol");
    const nested = item.kids.filter((k): k is Parent & ContentNode => k.t === "ul" || k.t === "ol");
    const text = inline(own).replace(/\n/g, `\n${pad}  `);
    if (text) lines.push(`${pad}${node.t === "ol" ? `${n}.` : "-"} ${text}`);
    for (const sub of nested) {
      const inner = list(sub, depth + 1);
      if (inner) lines.push(inner);
    }
  }
  return lines.join("\n");
}

function table(node: Parent): string {
  const rows = node.kids
    .filter((r) => r.t === "tr")
    .map((r) => (r as Parent).kids.filter((c) => c.t === "td" || c.t === "th").map((c) => inline((c as Parent).kids).replace(/\n/g, " ").replace(/\|/g, "\\|")))
    .filter((cells) => cells.some(Boolean));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
  return [line(rows[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** The tree as Markdown: blocks separated by a blank line. */
export function markdownOf(tree: readonly ContentNode[]): string {
  const blocks: string[] = [];
  let run: ContentNode[] = [];
  const flush = () => {
    const text = inline(run);
    if (text) blocks.push(text);
    run = [];
  };
  for (const n of tree) {
    if (!BLOCKS.has(n.t)) {
      run.push(n);
      continue;
    }
    flush();
    let text = "";
    if (n.t === "h") text = inline(n.kids) && `${"#".repeat(n.level)} ${inline(n.kids).replace(/\n/g, " ")}`;
    else if (n.t === "ul" || n.t === "ol") text = list(n, 0);
    else if (n.t === "table") text = table(n);
    else text = inline((n as { kids: ContentNode[] }).kids);
    if (text) blocks.push(text);
  }
  flush();
  return blocks.join("\n\n");
}

/**
 * In the page: `(CONTENT_SCRIPT)(document)` → `{ reader, tree }`. The root is
 * the visible <main>/[role=main] holding 200 characters or a quarter of the
 * page's text; else the one <article> (or
 * the largest, when it holds half the page's text: a list of cards is not one
 * article); else the deepest block holding half the page's text with little
 * of it in links; else the body. Inside it, navigation, header, footer, side
 * columns, dialogs, hidden parts and cookie or ad containers are left out.
 * The tree stops growing past MAX_TEXT characters.
 */
export const CONTENT_SCRIPT = `function content(doc) {
  var MAX_TEXT = 60000, MIN_ROOT = 200;
  var SKIP_TAGS = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, DIALOG: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, TEMPLATE: 1, IFRAME: 1, BUTTON: 1, SELECT: 1, INPUT: 1, TEXTAREA: 1, FORM: 0 };
  var SKIP_ROLES = { banner: 1, navigation: 1, contentinfo: 1, complementary: 1, dialog: 1, alertdialog: 1 };
  var NOISE = /cookie|consent|gdpr|banner-ad|advert/i;
  var body = doc.body;
  if (!body) return { reader: "text", tree: [] };
  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }
  function len(el) { return (el.innerText || "").trim().length; }
  function linkLen(el) {
    var n = 0, links = el.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) n += (links[i].innerText || "").trim().length;
    return n;
  }
  function skipped(el) {
    if (SKIP_TAGS[el.tagName] === 1) return true;
    var role = el.getAttribute("role");
    if (role && SKIP_ROLES[role]) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    var mark = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
    if (NOISE.test(mark)) return true;
    return !visible(el);
  }
  var whole = len(body), reader = "text", root = body;
  function enough(l) { return l > 0 && (l >= MIN_ROOT || l >= whole * 0.25); }
  var main = doc.querySelector("main, [role=main]");
  if (main && visible(main) && enough(len(main))) { root = main; reader = "main"; }
  else {
    var articles = doc.querySelectorAll("article"), best = null, bestLen = 0;
    for (var i = 0; i < articles.length; i++) {
      var l = visible(articles[i]) ? len(articles[i]) : 0;
      if (l > bestLen) { best = articles[i]; bestLen = l; }
    }
    if (best && enough(bestLen) && (articles.length === 1 || bestLen >= whole * 0.5)) { root = best; reader = "article"; }
    else {
      var blocks = body.querySelectorAll("div, section"), dense = null, denseLen = Infinity;
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j], bl = len(b);
        if (bl < whole * 0.5 || bl >= denseLen || bl < MIN_ROOT) continue;
        if (linkLen(b) >= bl * 0.3) continue;
        if (!visible(b)) continue;
        dense = b; denseLen = bl;
      }
      if (dense) { root = dense; reader = "dense"; }
    }
  }
  var used = 0;
  var BLOCK = /^(DIV|SECTION|ARTICLE|MAIN|FORM|FIELDSET|HEADER|FOOTER|ADDRESS|DL|FIGURE|DETAILS|SUMMARY|CENTER)$/;
  function walk(el) {
    var out = [];
    for (var c = el.firstChild; c && used < MAX_TEXT; c = c.nextSibling) {
      if (c.nodeType === 3) {
        var t = c.nodeValue;
        if (t && t.trim()) { out.push({ t: "text", text: t }); used += t.length; }
        continue;
      }
      if (c.nodeType !== 1 || skipped(c)) continue;
      var tag = c.tagName, m = /^H([1-6])$/.exec(tag);
      if (m) out.push({ t: "h", level: Number(m[1]), kids: walk(c) });
      else if (/^(P|BLOCKQUOTE|PRE|DD|DT|FIGCAPTION|CAPTION)$/.test(tag)) out.push({ t: "p", kids: walk(c) });
      else if (tag === "UL" || tag === "OL") out.push({ t: tag === "UL" ? "ul" : "ol", kids: walk(c).filter(function (k) { return k.t === "li"; }) });
      else if (tag === "LI") out.push({ t: "li", kids: walk(c) });
      else if (tag === "TABLE") out.push({ t: "table", kids: rows(c) });
      else if (tag === "A") out.push({ t: "a", href: c.href || "", kids: walk(c) });
      else if (tag === "STRONG" || tag === "B") out.push({ t: "strong", kids: walk(c) });
      else if (tag === "EM" || tag === "I") out.push({ t: "em", kids: walk(c) });
      else if (tag === "IMG") out.push({ t: "img", alt: c.getAttribute("alt") || "" });
      else if (tag === "BR") out.push({ t: "br" });
      else if (BLOCK.test(tag)) {
        var kids = walk(c), hasBlock = false;
        for (var k = 0; k < kids.length; k++) if (/^(h|p|ul|ol|table|li|tr)$/.test(kids[k].t)) hasBlock = true;
        if (hasBlock) out.push.apply(out, kids); else if (kids.length) out.push({ t: "p", kids: kids });
      } else out.push.apply(out, walk(c));
    }
    return out;
  }
  function rows(tableEl) {
    var out = [], trs = tableEl.querySelectorAll("tr");
    for (var i = 0; i < trs.length && used < MAX_TEXT; i++) {
      if (trs[i].closest("table") !== tableEl || skipped(trs[i])) continue;
      var cells = [];
      for (var c = trs[i].firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName === "TD" || c.tagName === "TH") cells.push({ t: c.tagName === "TH" ? "th" : "td", kids: walk(c) });
      }
      out.push({ t: "tr", kids: cells });
    }
    return out;
  }
  return { reader: reader, tree: walk(root) };
}`;
