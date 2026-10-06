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

  it("finds a value written as several, when each part was on the page", () => {
    const city = { url: "https://example.org/lisbon", text: "Lisbon is located in Portugal\nCapital city and municipality\t658,236\n3,353,000 within the metropolis (metro)\nView of the Tagus riverfront" };
    const result = prepareChoice("present_options", { items: [
      { title: "Lisbon", facts: [
        { label: "Population", value: "658 236 (city) / 3 353 000 (metro)" },
        { label: "River", value: "Tagus (Tejo)" },
        { label: "Area", value: "100 km2; 3 015 km2" },
      ], sourceUrl: city.url },
      { title: "Porto", facts: [{ label: "Country", value: "Portugal" }], sourceUrl: city.url },
    ] }, { pages: [city], local: [] });
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    // Both numbers and both notes are on the page; "Tejo" and the areas are not.
    expect(result.card.items[0]!.facts.map((fact) => fact.status)).toEqual(["page", "unverified", "unverified"]);
  });

  it("shows a price given as a fact as the card's price", () => {
    const result = prepareChoice("present_options", { items: [
      { title: "Skillet", facts: [{ label: "Price", value: "~£45" }, { label: "Brand", value: "Acme" }] },
      { title: "Scissors", price: "£20", facts: [{ label: "Fiyat", value: "£22" }] },
    ] }, { pages: [], local: [] });
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    expect(result.card.items[0]).toMatchObject({ price: { value: "~£45" }, facts: [{ label: "Brand", value: "Acme" }] });
    // A price already given stays; the fact is then the model's own second figure.
    expect(result.card.items[1]).toMatchObject({ price: { value: "£20" }, facts: [{ label: "Fiyat", value: "£22" }] });
    const ranges = prepareChoice("present_options", { items: [
      { title: "Oven", facts: [{ label: "Price range", value: "£50–£120" }] },
      { title: "Fırın", facts: [{ label: "Tahmini fiyat", value: "2.000 TL" }, { label: "Price per night", value: "£90" }] },
    ] }, { pages: [], local: [] });
    if (!("card" in ranges) || ranges.card.kind !== "options") throw new Error("card not made");
    expect(ranges.card.items.map((item) => item.price?.value)).toEqual(["£50–£120", "2.000 TL"]);
    expect(ranges.card.items[1]!.facts).toEqual([expect.objectContaining({ label: "Price per night" })]);
  });

  it("marks where a long text was cut, and still checks all of it", () => {
    const long = "A high-carbon steel kitchen knife with a flat blade edge, great for chopping, slicing and dicing";
    const page = { url: "https://example.org/knife", text: `Santoku\n${long}\nSteel: VG-10` };
    const result = prepareChoice("present_options", { items: [
      { title: "Santoku", facts: [{ label: "What it is", value: long }, { label: "Steel", value: "VG-10" }], view: "v".repeat(250), sourceUrl: page.url },
      { title: "Other", facts: [{ label: "What it is", value: long.replace("chopping", "carving") }], sourceUrl: page.url },
    ] }, { pages: [page], local: [] });
    if (!("card" in result) || result.card.kind !== "options") throw new Error("card not made");
    const [shown, other] = [result.card.items[0]!.facts[0]!, result.card.items[1]!.facts[0]!];
    expect(shown.value.length).toBeLessThanOrEqual(80);
    expect(shown.value.endsWith("…") && long.startsWith(shown.value.slice(0, -1))).toBe(true);
    // The whole sentence was on the page; the one that differs past the cut was not.
    expect([shown.status, other.status]).toEqual(["page", "unverified"]);
    expect(result.card.items[0]!.facts[1]!.value).toBe("VG-10");
    expect(result.card.items[0]!.view).toMatch(/^v{199}…$/);
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

  it("does not ask again, with buttons, about options the user has just chosen from", async () => {
    const cards = '{"items":[{"title":"Chef\'s Knife","facts":[{"label":"Use","value":"daily"}]},{"title":"Spice Box","facts":[{"label":"Use","value":"monthly"}]}]}';
    const recap = "Here's a summary:\n\n1. **Chef's Knife** — a hand-forged knife.\n2. **Spice Box** — a monthly delivery.\n\nYou chose the **Chef's Knife**. Would you like me to look up retailers for that?";
    const { chat, seen } = model([{ calls: [{ name: "present_options", argumentsText: cards }] }, { text: recap }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Gift ideas", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(events.filter((event) => event.type === "choice.asked")).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(result).toMatchObject({ status: "done", detail: recap });
  });

  it("asks once for cards when the request named them and the answer was prose", async () => {
    const cards = '{"items":[{"title":"Mantı","facts":[{"label":"Time","value":"1 h"}]},{"title":"Köfte","facts":[{"label":"Time","value":"45 min"}]}]}';
    const { chat, seen } = model([
      { text: "1. Mantı: about an hour.\n2. Köfte: 45 minutes.\n\nTell me which you want a recipe for." },
      { calls: [{ name: "present_options", argumentsText: cards }] },
      { text: "Mantı it is." },
    ]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Two dinner ideas as option cards", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(seen[1]!.messages.at(-1)!.content).toContain("asked for option cards");
    expect(events).toContainEqual(expect.objectContaining({ type: "choice.asked", card: expect.objectContaining({ kind: "options", unchecked: true }) }));
    // The cards say which step's text they stand in for, so it is not shown twice.
    const first = events.find((event) => event.type === "step.started");
    const asked = events.find((event) => event.type === "choice.asked");
    expect(first?.type === "step.started" && asked?.type === "choice.asked" && asked.replaces === first.stepId && asked.stepId !== first.stepId).toBe(true);
    expect(result).toMatchObject({ status: "done", detail: "Mantı it is." });
    // A request that names no cards is left as it was answered.
    const plain = model([{ text: "1. Mantı: about an hour.\n2. Köfte: 45 minutes.\n\nEnjoy." }]);
    await runAgent({ goal: "Two dinner ideas", model: plain.chat, tools: registry, emit: () => {}, requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(plain.seen).toHaveLength(1);
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
