import { describe, expect, it } from "vitest";
import { filterMentions, fold, insertMention, mentionName, mentionQuery } from "../../src/renderer/src/lib/mention.js";

const tr = (s: string): string => s.toLocaleLowerCase("tr");
const en = (s: string): string => s.toLocaleLowerCase("en");

describe("mentionQuery", () => {
  it("finds the @ being typed, at the start or after a space", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("see @ro", 7)).toEqual({ start: 4, query: "ro" });
    expect(mentionQuery("line\n@ro", 8)).toEqual({ start: 5, query: "ro" });
  });

  it("lets a query hold spaces, since names do", () => {
    expect(mentionQuery("@rome tr", 8)).toEqual({ start: 0, query: "rome tr" });
  });

  it("takes the @ nearest before the caret", () => {
    expect(mentionQuery("@a and @b", 9)).toEqual({ start: 7, query: "b" });
    expect(mentionQuery("@a and @b", 2)).toEqual({ start: 0, query: "a" });
  });

  it.each([
    ["no @ at all", "hello", 5],
    ["an @ inside a word", "write to a@b.com", 16],
    ["a space right after the @", "meet @ 5pm", 10],
    ["a new line since the @", "@rome\nnext", 10],
    ["more than 40 characters since the @", `@${"x".repeat(41)}`, 42],
    ["the caret before the @", "hi @rome", 2],
  ])("is not a mention with %s", (_name, text, caret) => {
    expect(mentionQuery(text, caret)).toBeNull();
  });

  it("is over once the name was picked", () => {
    expect(mentionQuery("@Rome trip and", 14, ["Rome trip"])).toBeNull();
    expect(mentionQuery("@Rome trip and @pa", 18, ["Rome trip"])).toEqual({ start: 15, query: "pa" });
  });
});

describe("filterMentions", () => {
  const items = ["İstanbul gezisi", "Şarj istasyonu", "Hotel in Rome", "Rome flights"].map((name) => ({ name }));

  it("ignores case and accents, by Turkish rules in Turkish", () => {
    expect(filterMentions(items, "ISTANBUL", tr).map((i) => i.name)).toEqual(["İstanbul gezisi"]);
    expect(filterMentions(items, "istanbul", tr).map((i) => i.name)).toEqual(["İstanbul gezisi"]);
    expect(filterMentions(items, "sarj", tr).map((i) => i.name)).toEqual(["Şarj istasyonu"]);
    expect(filterMentions(items, "ISTANBUL", en).map((i) => i.name)).toEqual(["İstanbul gezisi"]);
  });

  it("wants every word, in any order", () => {
    expect(filterMentions(items, "rome hotel", en).map((i) => i.name)).toEqual(["Hotel in Rome"]);
  });

  it("keeps the order and shows eight at most", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `n${i}` }));
    expect(filterMentions(many, "", en).map((i) => i.name)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  });

  it("folds text one way for both sides", () => {
    expect(fold("ÇĞİÖŞÜ ı", tr)).toBe("cgiosu i");
  });
});

describe("mentionName", () => {
  it("is one line, cut at forty characters", () => {
    expect(mentionName("  Rome\n  trip ")).toBe("Rome trip");
    const long = mentionName("a".repeat(30) + " " + "b".repeat(30));
    expect(long).toHaveLength(40);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("insertMention", () => {
  it("replaces what was typed with the name and a space", () => {
    expect(insertMention("see @ro", 4, 7, "Rome trip")).toEqual({ text: "see @Rome trip ", caret: 15 });
  });

  it("does not double a space that is already there", () => {
    expect(insertMention("see @ro now", 4, 7, "Rome trip")).toEqual({ text: "see @Rome trip now", caret: 15 });
  });
});
