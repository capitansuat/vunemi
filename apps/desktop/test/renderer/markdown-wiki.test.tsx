/** [[links]] between topic notes: a button on the Memory page when the note is there, the words alone otherwise. */
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { Markdown, wikiLink } from "../../src/renderer/src/components/Markdown.js";

function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}

describe("[[links]]", () => {
  it("reads the title and what it shows, as Obsidian writes them", () => {
    expect(wikiLink("[[Budget]]")).toEqual({ title: "Budget", shown: "Budget" });
    expect(wikiLink("[[Budget|the money]]")).toEqual({ title: "Budget", shown: "the money" });
    expect(wikiLink("[[Budget#Total]]")).toEqual({ title: "Budget", shown: "Budget#Total" });
    expect(wikiLink("[[Budget#Total|total]]")).toEqual({ title: "Budget", shown: "total" });
  });

  it("opens a note that is there and leaves one that isn't as words", () => {
    setLocale("en");
    const open = vi.fn();
    const tree = Markdown({ text: "Within [[Budget|the budget]]; ask [[Plumber]].", wiki: { exists: (t) => t === "Budget", open } });
    const buttons = nodes(tree).filter((n) => n.type === "button");
    expect(buttons.map((b) => b.props.children)).toEqual(["the budget"]);
    buttons[0].props.onClick();
    expect(open).toHaveBeenCalledWith("Budget");
    const missing = nodes(tree).find((n) => n.type === "span" && n.props.children === "Plumber");
    expect(missing.props.title).toBe("There is no note “Plumber” yet.");
  });

  it("is the words alone in a chat answer", () => {
    const tree = Markdown({ text: "See [[Budget]]." });
    expect(nodes(tree).some((n) => n.type === "button")).toBe(false);
    expect(nodes(tree).some((n) => n.type === "span" && n.props.children === "Budget")).toBe(true);
  });
});
