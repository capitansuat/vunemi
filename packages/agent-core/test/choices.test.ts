import { describe, expect, it } from "vitest";
import { choiceTools, listChoiceInput, prepareChoice, tableChoiceInput, valueSeen } from "../src/choices.js";
import { runAgent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools.js";
import type { AgentEvent } from "../src/events.js";
import type { ChatModel, ChatRequest, ChatResult } from "../src/provider.js";

const page = { url: "https://example.com/laptop", text: "[tab 1] Laptop — https://example.com/laptop\nFiyat: 62.499 TL\nRAM 16 GB" };
const evidence = { pages: [page], local: ["Calendar: Friday 14:00"] };

describe("choice card data", () => {
  it("extracts only complete comparison rows and keeps missing prices absent", () => {
    expect(tableChoiceInput("| Airline | Price | Stops |\n|---|---|---|\n| A | £311 | Direct |\n| B | — | 1 stop |"))
      .toEqual({ items: [
        { title: "A", price: "£311", facts: [{ label: "Stops", value: "Direct" }] },
        { title: "B", facts: [{ label: "Stops", value: "1 stop" }] },
      ] });
    const oneRow = tableChoiceInput("| Airline | Price |\n|---|---|\n| A | £311 |");
    expect(oneRow).toBeNull();
  });
  it("reads a question written as a short list, and nothing that is an answer", () => {
    expect(listChoiceInput("Friday dinner — which cuisine sounds good?\n\n1. **Italian** (pasta, risotto…)\n2. **Japanese** (ramen…)\n3. **Something else** — tell me!"))
      .toEqual({ question: "Friday dinner — which cuisine sounds good?", options: ["Italian", "Japanese"], allowOther: true });
    expect(listChoiceInput("Tarih esnek mi?\n- Yalnız Cuma\n- ±2 gün\nİstersen kendin yaz."))
      .toEqual({ question: "Tarih esnek mi?", options: ["Yalnız Cuma", "±2 gün"], allowOther: true });
    // The question after the list, each item a name in bold and a long description.
    expect(listChoiceInput(`Friday dinner — Turkish:\n\n1. **Köfte + pilav** — ${"grilled patties with rice ".repeat(5)}\n2. **Karnıyarık** — baked eggplant.\n\nWhich one?`))
      .toEqual({ question: "Which one?", options: ["Köfte + pilav", "Karnıyarık"], allowOther: true });
    // An answer that lists things, a list with one item, long items, a long lead-in, too many.
    expect(listChoiceInput("Here are three ideas:\n1. Ramen\n2. Tacos\n3. Curry")).toBeNull();
    expect(listChoiceInput("Here are three ideas:\n1. Ramen\n2. Tacos\nEnjoy your dinner.")).toBeNull();
    expect(listChoiceInput("Which one?\n1. Ramen")).toBeNull();
    expect(listChoiceInput(`Which one?\n1. ${"a".repeat(90)}\n2. b`)).toBeNull();
    expect(listChoiceInput(`${"I looked into it. ".repeat(20)}\nWhich one?\n1. Ramen\n2. Tacos`)).toBeNull();
    expect(listChoiceInput("Which one?\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f")).toBeNull();
  });

  it("bounds content and rejects incomplete choices", () => {
    expect(prepareChoice("ask_choice", { question: "?", options: ["one"] }, evidence)).toHaveProperty("error");
    const result = prepareChoice("ask_choice", { question: "Q".repeat(210), options: ["A".repeat(90), "B", "C", "D", "E", "F"] }, evidence);
    expect("card" in result && result.card.kind === "choice" && result.card.question.length).toBe(200);
    expect("card" in result && result.card.kind === "choice" && result.card.options).toHaveLength(5);
  });

  it("says so when nothing was read, instead of marking every value as not found", () => {
    const items = [{ title: "Köfte", facts: [{ label: "Time", value: "45 min" }] }, { title: "Mantı", facts: [{ label: "Time", value: "1 h" }] }];
    expect(prepareChoice("present_options", { items }, { pages: [], local: [] })).toMatchObject({ card: { unchecked: true } });
    const read = prepareChoice("present_options", { items }, evidence);
    expect("card" in read && read.card.kind === "options" && read.card.unchecked).toBeUndefined();
  });

  it("checks a card that names no source against the pages read in this run", () => {
    const other = { url: "https://example.com/phone#specs", text: "RAM 8 GB\nWeight 200 g" };
    const result = prepareChoice("present_options", { items: [
      { title: "Laptop", price: "62499 TL", facts: [{ label: "RAM", value: "16 GB" }, { label: "Weight", value: "1 kg" }] },
      { title: "Phone", facts: [{ label: "RAM", value: "8 GB" }] },
      { title: "Nowhere", facts: [{ label: "RAM", value: "64 GB" }] },
    ] }, { pages: [page, other], local: [] });
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    expect(result.card.items[0]).toMatchObject({ sourceUrl: page.url, price: { status: "page" }, facts: [{ status: "page" }, { status: "unverified" }] });
    expect(result.card.items[1]).toMatchObject({ sourceUrl: "https://example.com/phone", facts: [{ status: "page" }] });
    expect(result.card.items[2]!.sourceUrl).toBeUndefined();
    expect(result.card.items[2]!.facts[0]!.status).toBe("unverified");
  });

  it("matches read page values and prices, including thousands separators", () => {
    expect(valueSeen("62499 TL", page.text)).toBe(true);
    expect(valueSeen("16 GB", "RAM 116 GB")).toBe(false);
    expect(valueSeen("100 TL", "Fiyat 1100 TL")).toBe(false);
    expect(valueSeen("16 GB", "RAM 16 GB")).toBe(true);
    const result = prepareChoice("present_options", { items: [
      { title: "A", price: "62499 TL", facts: [{ label: "RAM", value: "16 GB" }, { label: "Weight", value: "1 kg" }], sourceUrl: page.url },
      { title: "B", facts: [{ label: "When", value: "Friday 14:00" }], sourceUrl: "https://example.com/not-opened" },
    ] }, evidence);
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    expect(result.card.items[0]).toMatchObject({ sourceUrl: page.url, price: { status: "page" }, facts: [{ status: "page" }, { status: "unverified" }] });
    expect(result.card.items[1]).toMatchObject({ facts: [{ status: "local" }] });
    expect(result.card.items[1]!.sourceUrl).toBeUndefined();
  });

  it("treats card strings as plain text and trims facts", () => {
    const result = prepareChoice("present_options", { items: [
      { title: "<b>One</b>", view: "[buy](https://bad.example)", facts: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: `V${i}` })) },
      { title: "Two", facts: [] },
    ] }, evidence);
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    expect(result.card.items[0]).toMatchObject({ title: "One", view: "buy" });
    expect(result.card.items[0]!.facts).toHaveLength(6);
  });
});

function model(turns: { calls?: { name: string; argumentsText: string }[]; text?: string }[]) {
  const seen: ChatRequest[] = [];
  let n = 0;
  const chat: ChatModel = { id: "fake:choices", async chat(req): Promise<ChatResult> {
    seen.push(req);
    const turn = turns[n++];
    if (!turn) throw new Error("Script exhausted");
    return { text: turn.text ?? "", toolCalls: (turn.calls ?? []).map((call, i) => ({ ...call, id: `call-${n}-${i}` })), usage: { promptTokens: 1, completionTokens: 1, ttftMs: 1, tokensPerSec: 1 } };
  } };
  return { chat, seen };
}

describe("choice run", () => {
  it("grades cards from page text actually read in this run", async () => {
    const { chat } = model([
      { calls: [{ name: "page_read", argumentsText: "{}" }] },
      { calls: [{ name: "present_options", argumentsText: JSON.stringify({ items: [
        { title: "Laptop A", price: "62499 TL", sourceUrl: page.url, facts: [{ label: "RAM", value: "16 GB" }] },
        { title: "Laptop B", price: "100 TL", sourceUrl: "https://example.com/other", facts: [] },
      ] }) }] },
      { text: "You picked Laptop A." },
    ]);
    const registry = new ToolRegistry().register({ name: "page_read", description: "read page", parameters: { type: "object", properties: {} }, actionClass: "read", untrustedOutput: true, run: async () => page.text }, "browser");
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Compare laptops", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result.status).toBe("done");
    const asked = events.find((event) => event.type === "choice.asked");
    if (!asked || asked.type !== "choice.asked" || asked.card.kind !== "options") throw new Error("cards not shown");
    expect(asked.card.items[0]).toMatchObject({ sourceUrl: page.url, price: { status: "page" }, facts: [{ status: "page" }] });
    expect(asked.card.items[1]).toMatchObject({ price: { status: "unverified" } });
    expect(asked.card.items[1]!.sourceUrl).toBeUndefined();
  });

  it("waits for a decision and returns it to the model as untrusted tool data", async () => {
    const { chat, seen } = model([
      { calls: [{ name: "ask_choice", argumentsText: '{"question":"When?","options":["Friday","Saturday"]}' }] },
      { text: "Friday works." },
    ]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    let answer!: (value: { text: string; index?: number }) => void;
    const finished = runAgent({ goal: "Choose a day", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: () => new Promise((resolve) => { answer = resolve; }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === "choice.asked")).toBe(true);
    answer({ text: "", index: 0 });
    expect((await finished).status).toBe("done");
    expect(events).toContainEqual(expect.objectContaining({ type: "choice.answered", text: "Friday" }));
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining('<untrusted_content source="user_selection">') });
  });

  it("asks with buttons when the model wrote its question as a list, twice in a task at most", async () => {
    const { chat, seen } = model([
      { text: "Which cuisine?\n1. **Italian** (pasta)\n2. **Japanese** (ramen)" },
      { text: "Which dish?\n1. Ramen\n2. Katsu" },
      { text: "Which drink?\n1. Tea\n2. Water" },
    ]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Dinner idea, ask me first", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 1 }) });
    expect(events.filter((event) => event.type === "choice.asked")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "choice.asked", card: { kind: "choice", question: "Which cuisine?", options: ["Italian", "Japanese"], allowOther: true } }));
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining('The user chose: "Japanese"') });
    // The third list stays an answer: the user picks from it by writing.
    expect(result).toMatchObject({ status: "done", detail: expect.stringContaining("Which drink?") });
  });

  it("does not offer or wait for choice tools in unattended runs", async () => {
    const { chat, seen } = model([{ text: "Done" }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const result = await runAgent({ goal: "Scheduled", model: chat, tools: registry, emit: () => {}, requestApproval: async () => ({ kind: "approve" }), requestChoice: () => { throw new Error("must not wait"); }, unattended: true });
    expect(result.status).toBe("done");
    expect(seen[0]!.tools.map((tool) => tool.name)).toEqual([]);
  });
});
