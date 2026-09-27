import { describe, expect, it } from "vitest";
import { find, outline, type AXNode } from "../src/ax.js";

/** Tiny builder: tree([role, name?, props?, ...children]) → flat CDP-style node list. */
type Spec = {
  role: string;
  name?: string;
  value?: string;
  ignored?: boolean;
  props?: Record<string, unknown>;
  children?: Spec[];
};

function tree(root: Spec): AXNode[] {
  const out: AXNode[] = [];
  let next = 1;
  const walk = (s: Spec, parentId?: string): string => {
    const nodeId = String(next);
    const backend = 100 + next++;
    const node: AXNode = {
      nodeId,
      ignored: s.ignored ?? false,
      role: { value: s.role },
      ...(s.name !== undefined && { name: { value: s.name } }),
      ...(s.value !== undefined && { value: { value: s.value } }),
      ...(s.props && { properties: Object.entries(s.props).map(([name, v]) => ({ name, value: { value: v } })) }),
      ...(parentId !== undefined && { parentId }),
      backendDOMNodeId: backend,
    };
    out.push(node);
    node.childIds = (s.children ?? []).map((c) => walk(c, nodeId));
    return nodeId;
  };
  walk(root);
  return out;
}

const page = tree({
  role: "RootWebArea",
  name: "Shop",
  children: [
    {
      role: "generic",
      ignored: true,
      children: [
        {
          role: "navigation",
          children: [
            { role: "link", name: "Home", children: [{ role: "StaticText", name: "Home", children: [{ role: "InlineTextBox", name: "Home" }] }] },
            { role: "link", name: "Cart (2)" },
          ],
        },
      ],
    },
    {
      role: "main",
      children: [
        { role: "heading", name: "Blue shoes", props: { level: 1 } },
        { role: "generic", children: [{ role: "paragraph", children: [{ role: "StaticText", name: "Comfortable   and\n light." }] }] },
        { role: "textbox", name: "Quantity", value: "1", props: { required: true, focused: false } },
        { role: "checkbox", name: "Gift wrap", props: { checked: "false" } },
        { role: "button", name: "Add to cart", children: [{ role: "StaticText", name: "Add to cart" }] },
      ],
    },
  ],
});

describe("outline", () => {
  it("keeps what a model needs and drops the noise", () => {
    const { text, stats } = outline(page);
    expect(text).toBe(
      [
        "[101] RootWebArea \"Shop\"",
        "  [103] navigation",
        "    [104] link \"Home\"",
        "    [107] link \"Cart (2)\"",
        "  [108] main",
        "    [109] h1 \"Blue shoes\"",
        "    Comfortable and light.",
        "    [113] textbox \"Quantity\" value=\"1\" required",
        "    [114] checkbox \"Gift wrap\" checked=false",
        "    [115] button \"Add to cart\"",
      ].join("\n"),
    );
    // Ignored wrapper, nameless generics, paragraph, echoed texts, InlineTextBox: all gone.
    expect(stats.rawNodes).toBe(16);
    expect(stats.keptNodes).toBe(10);
  });

  it("interactiveOnly leaves just actionable elements and headings", () => {
    const { text } = outline(page, { interactiveOnly: true });
    expect(text.split("\n").map((l) => l.trim())).toEqual([
      '[104] link "Home"',
      '[107] link "Cart (2)"',
      '[109] h1 "Blue shoes"',
      '[113] textbox "Quantity" value="1" required',
      '[114] checkbox "Gift wrap" checked=false',
      '[115] button "Add to cart"',
    ]);
  });

  it("marks elements that are new since the previous outline", () => {
    const first = outline(page);
    const previous = new Set([...first.refs].filter((r) => r !== 115));
    const { text } = outline(page, { previousRefs: previous });
    expect(text).toContain('*[115] button "Add to cart"');
    expect(text).toContain('[114] checkbox'); // unchanged → unmarked
    expect(text).not.toContain("*[114]");
  });

  it("zooms into a subtree by ref", () => {
    const { text } = outline(page, { rootRef: 103 });
    expect(text).toBe(['[103] navigation', '  [104] link "Home"', '  [107] link "Cart (2)"'].join("\n"));
  });

  it("counts depth over kept elements, so maxDepth cuts the pruned tree", () => {
    const { text } = outline(page, { maxDepth: 2 });
    expect(text).toContain("  [108] main");
    expect(text).not.toContain("[109]");
  });

  it("stops at the character budget and says how much it left out", () => {
    const { text, stats } = outline(page, { maxChars: 80 });
    expect(text.length).toBeLessThan(80 + 200);
    expect(stats.omittedNodes).toBeGreaterThan(0);
    expect(text).toMatch(/… \d+ more elements not shown\. Use page_find/);
  });

  it("clips very long names", () => {
    const long = tree({ role: "RootWebArea", children: [{ role: "link", name: "x".repeat(500) }] });
    // The nameless root is dropped, so the link is the first and only line.
    expect(outline(long, { maxTextLength: 50 }).text).toBe(`[102] link "${"x".repeat(49)}…"`);
  });

  it("returns empty for an empty or unknown root", () => {
    expect(outline([]).text).toBe("");
    expect(outline(page, { rootRef: 9999 }).text).toBe("");
  });
});

describe("find", () => {
  it("matches names and values case-insensitively, without text nodes", () => {
    expect(find(page, "cart")).toEqual(['[107] link "Cart (2)"', '[115] button "Add to cart"']);
    expect(find(page, "   ")).toEqual([]);
  });
});
