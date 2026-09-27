/**
 * Turns Chromium's full accessibility tree into a compact text outline a
 * small local model can afford to read every step.
 *
 * The raw tree from `Accessibility.getFullAXTree` is mostly noise: ignored
 * wrappers, nameless `generic` divs, and text nodes that repeat their
 * parent's label. Chromium has already done the hard part (computing each
 * element's role and accessible name, shadow DOM included), so pruning is
 * mostly about knowing what to throw away.
 *
 * Each kept element carries a ref — its `backendDOMNodeId` — which the
 * action tools resolve straight back to a DOM node. No CSS selectors.
 */

/** The subset of CDP's `Accessibility.AXNode` we read. */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface OutlineOptions {
  /** Only emit this subtree (a ref from a previous outline). */
  rootRef?: number;
  /** Refs present in the previous outline; others are marked new with `*`. */
  previousRefs?: ReadonlySet<number>;
  /** Keep only interactive elements and headings. */
  interactiveOnly?: boolean;
  /** Depth counted over kept elements, not raw nodes. */
  maxDepth?: number;
  /** Soft cap on output size in characters (~4 chars per token). */
  maxChars?: number;
  /** Per-name/value cap. */
  maxTextLength?: number;
}

export interface Outline {
  text: string;
  /** Every ref that appears in `text`, for the next call's `previousRefs`. */
  refs: Set<number>;
  stats: {
    rawNodes: number;
    keptNodes: number;
    /** Kept nodes cut off by `maxChars`. */
    omittedNodes: number;
    chars: number;
  };
}

/** Roles a user (or agent) can act on. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "treeitem",
  "gridcell",
  "columnheader",
  "textField",
]);

/** Containers that only matter if they have a name of their own. */
const STRUCTURAL = new Set([
  "generic",
  "none",
  "presentation",
  "LabelText",
  "MenuListPopup",
  "paragraph",
  "group",
  "list",
  "listitem",
  "section",
  "Section",
  "div",
  "Div",
  "strong",
  "emphasis",
  "time",
  "Abbr",
  "DescriptionList",
  "DescriptionListTerm",
  "DescriptionListDetail",
  "Figcaption",
  "figure",
  "blockquote",
  "code",
  "Pre",
  "subscript",
  "superscript",
  "mark",
  "Ruby",
  "table",
  "rowgroup",
  "row",
  "cell",
  "RootWebArea",
  "WebArea",
  "Iframe",
  "IframePresentational",
]);

/** Never worth a line. */
const DROP = new Set(["InlineTextBox", "LineBreak", "ListMarker", "ScrollBar", "Canvas", "Legend"]);

const TEXT_ROLES = new Set(["StaticText", "text"]);

/** Boolean-ish states worth telling the model, only when true. */
const TRUE_FLAGS = ["focused", "disabled", "selected", "required", "readonly", "modal", "expanded", "invalid"];
/** Tristate states, reported including "false" / "mixed". */
const TRISTATE = ["checked", "pressed"];

export function outline(nodes: AXNode[], opts: OutlineOptions = {}): Outline {
  const maxText = opts.maxTextLength ?? 200;
  const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines: string[] = [];
  const refs = new Set<number>();
  let chars = 0;
  let kept = 0;
  let omitted = 0;

  const root = findRoot(nodes, byId, opts.rootRef);
  if (!root) {
    return { text: "", refs, stats: { rawNodes: nodes.length, keptNodes: 0, omittedNodes: 0, chars: 0 } };
  }

  // Iterative DFS so a pathological page can't blow the stack.
  // `label` is the nearest kept ancestor's name, used to drop echoes of it.
  const stack: { id: string; depth: number; label: string }[] = [{ id: root.nodeId, depth: 0, label: "" }];
  while (stack.length > 0) {
    const { id, depth, label } = stack.pop()!;
    const node = byId.get(id);
    if (!node) continue;

    const decision = keep(node, label, opts.interactiveOnly === true);
    let childDepth = depth;
    let childLabel = label;

    if (decision !== null) {
      if (depth < maxDepth) {
        const line = render(node, decision, depth, maxText, opts.previousRefs);
        if (chars + line.length + 1 <= maxChars) {
          lines.push(line);
          chars += line.length + 1;
          kept++;
          if (node.backendDOMNodeId !== undefined) refs.add(node.backendDOMNodeId);
        } else {
          omitted++;
        }
      }
      childDepth = depth + 1;
      childLabel = normalise(str(node.name?.value)) || label;
    }

    // Push children in reverse so they pop in document order.
    const children = node.childIds ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ id: children[i]!, depth: childDepth, label: childLabel });
    }
  }

  if (omitted > 0) {
    const note = `… ${omitted} more elements not shown. Use page_find to search, or page_describe with a ref to zoom into a section.`;
    lines.push(note);
    chars += note.length;
  }

  return {
    text: lines.join("\n"),
    refs,
    stats: { rawNodes: nodes.length, keptNodes: kept, omittedNodes: omitted, chars },
  };
}

type Kind = "interactive" | "heading" | "text" | "landmark";

/** Returns how to render the node, or null to skip it (its children are still visited). */
function keep(node: AXNode, ancestorLabel: string, interactiveOnly: boolean): Kind | null {
  if (node.ignored) return null;
  const role = str(node.role?.value);
  if (DROP.has(role)) return null;

  const name = normalise(str(node.name?.value));
  const value = normalise(str(node.value?.value));

  if (INTERACTIVE_ROLES.has(role)) return "interactive";
  if (role === "heading") return name ? "heading" : null;

  if (interactiveOnly) return null;

  if (TEXT_ROLES.has(role)) {
    if (!name) return null;
    // "Submit" inside the "Submit" button, or a fragment of the parent's label.
    if (ancestorLabel && (ancestorLabel === name || ancestorLabel.includes(name))) return null;
    return "text";
  }
  if (STRUCTURAL.has(role)) return name || value ? "landmark" : null;
  if (role === "image" || role === "img") return name ? "landmark" : null;
  // Landmarks (navigation, main, form, dialog, …) orient the model even unnamed.
  return "landmark";
}

function render(node: AXNode, kind: Kind, depth: number, maxText: number, previous?: ReadonlySet<number>): string {
  const indent = "  ".repeat(depth);
  const role = str(node.role?.value);
  const name = clip(normalise(str(node.name?.value)), maxText);

  if (kind === "text") return `${indent}${name}`;

  const ref = node.backendDOMNodeId;
  const fresh = ref !== undefined && previous !== undefined && !previous.has(ref);
  const tag = ref === undefined ? "" : fresh ? `*[${ref}] ` : `[${ref}] `;

  let line = `${indent}${tag}${role}`;
  if (role === "heading") {
    const level = prop(node, "level");
    if (level !== undefined) line = `${indent}${tag}h${String(level)}`;
  }
  if (name) line += ` "${name}"`;

  const value = clip(normalise(str(node.value?.value)), maxText);
  if (value && value !== name) line += ` value="${value}"`;

  const flags: string[] = [];
  for (const f of TRUE_FLAGS) if (prop(node, f) === true) flags.push(f);
  for (const f of TRISTATE) {
    const v = prop(node, f);
    if (v !== undefined) flags.push(`${f}=${String(v)}`);
  }
  if (flags.length > 0) line += ` ${flags.join(" ")}`;
  return line;
}

function findRoot(nodes: AXNode[], byId: Map<string, AXNode>, rootRef?: number): AXNode | undefined {
  if (rootRef !== undefined) return nodes.find((n) => n.backendDOMNodeId === rootRef);
  return nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId));
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Searches the tree by accessible name (case-insensitive) and returns one
 * line per match — the cheap alternative to reading the whole page.
 */
export function find(nodes: AXNode[], query: string, limit = 20): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const out: string[] = [];
  for (const node of nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const role = str(node.role?.value);
    if (TEXT_ROLES.has(role) || DROP.has(role)) continue;
    const name = normalise(str(node.name?.value));
    const value = normalise(str(node.value?.value));
    if (!name.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) continue;
    const kind = keep(node, "", false);
    if (kind === null) continue;
    out.push(render(node, kind, 0, 200));
    if (out.length >= limit) break;
  }
  return out;
}
