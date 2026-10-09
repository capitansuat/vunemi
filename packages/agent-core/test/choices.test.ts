import { describe, expect, it } from "vitest";
import { bareQuestion, choiceTools, comparisonTable, listChoiceInput, prepareChoice, tableChoiceInput, valueSeen } from "../src/choices.js";
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
      .toEqual({ question: "Which one?", options: ["Köfte + pilav", "Karnıyarık"], allowOther: true, closing: true });
    // An answer that lists things, a list with one item, long items, a long lead-in, too many.
    expect(listChoiceInput("Here are three ideas:\n1. Ramen\n2. Tacos\n3. Curry")).toBeNull();
    expect(listChoiceInput("Here are three ideas:\n1. Ramen\n2. Tacos\nEnjoy your dinner.")).toBeNull();
    expect(listChoiceInput("Which one?\n1. Ramen")).toBeNull();
    expect(listChoiceInput(`Which one?\n1. ${"a".repeat(90)}\n2. b`)).toBeNull();
    expect(listChoiceInput(`${"I looked into it. ".repeat(20)}\nWhich one?\n1. Ramen\n2. Tacos`)).toBeNull();
    expect(listChoiceInput("Which one?\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i")).toBeNull();
    // After the list, a question is as often an offer under an answer: five at most, and one short line.
    expect(listChoiceInput("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\nWhich one?")).toBeNull();
    expect(listChoiceInput(`1. Ramen\n2. Tacos\nWould you like more on either? ${"I can go deeper. ".repeat(8)}`)).toBeNull();
  });

  it("takes a question under a list only when it asks which of them", () => {
    const list = "Here are three:\n\n1. **Golden Crumb** – warm and rustic.\n2. **The Daily Rise** – fresh every morning.\n3. **Flour & Hearth** – cozy.\n\n";
    const names = ["Golden Crumb", "The Daily Rise", "Flour & Hearth"];
    // As the model asked it live, under names it had been told the user would pick from.
    for (const question of ["Which one do you like best?", "Which of these would you like to try?", "Which one do you like, or would you like me to suggest a different style (e.g. more modern, punny)?", "Hangisini tercih edersin?"]) {
      expect(listChoiceInput(list + question), question).toEqual({ question, options: names, allowOther: true, closing: true });
    }
    // An offer under an answer, also live: its answers are yes and no, not the items above it.
    for (const offer of ["Want me to adjust the tone or try more?", "Would you like suggestions for a specific dietary preference (e.g., vegan, low-carb, high-protein)?", "Want me to flesh one out with a step-by-step plan?", "Daha fazlasını ister misin?", "İstersen daha fazla öneri vereyim mi?", "Shall I go on?"]) {
      expect(listChoiceInput(list + offer), offer).toBeNull();
    }
    // The other languages the app speaks.
    for (const question of ["Welches gefällt dir am besten?", "Lequel préférez-vous ?", "¿Cuál prefieres?", "Quale preferisci?", "Qual você prefere?", "Какой вам больше нравится?", "你喜欢哪一个？", "どれがいいですか？", "어느 것이 마음에 드세요?"]) {
      expect(listChoiceInput(list + question)?.options, question).toEqual(names);
    }
    for (const offer of ["Soll ich mehr vorschlagen?", "Voulez-vous d'autres idées ?", "¿Quieres más opciones?", "Vuoi altre idee?", "Quer mais opções?", "Хотите ещё варианты?", "需要更多建议吗？", "もっと提案しましょうか？", "더 추천해 드릴까요?"]) {
      expect(listChoiceInput(list + offer), offer).toBeNull();
    }
  });

  it("finds the question under a list among the sentences around it", () => {
    const list = "1. **Golden Crumb** – warm and rustic.\n2. **The Daily Rise** – fresh every morning.\n\n";
    const asked = (tail: string): string | undefined => listChoiceInput(list + tail)?.question;
    // As the model wrote them live.
    expect(asked("Hangisini izlemek istersin? Sadece numarasını söylemen yeterli, detaylı bilgi vereyim.")).toBe("Hangisini izlemek istersin?");
    expect(asked("Which one interests you? Pick one and I’ll help you get started.")).toBe("Which one interests you?");
    expect(asked("Each one leans into the rainy mood rather than fighting it. Which one sounds most appealing?")).toBe("Which one sounds most appealing?");
    expect(asked("Which one calls to you? 🍳")).toBe("Which one calls to you?");
    expect(asked("Hangisine başlamak istersin? Ya da başka bir dil aklında mı var?")).toBe("Hangisine başlamak istersin?");
    expect(asked("All three are easy to say.\nWhich of these (or a variation) do you lean towards? I can refine it once you pick.")).toBe("Which of these (or a variation) do you lean towards?");
    // A long introduction is an answer's, and the question under the list still stands.
    expect(listChoiceInput(`${"These names came from the street the shop is on. ".repeat(8)}\n${list}Which one?`)).toMatchObject({ question: "Which one?", closing: true });
    // "Which" in a statement, a question a sentence later; a page of text; no question mark.
    expect(asked("Which one is best depends on your budget. Want details?")).toBeUndefined();
    expect(asked(`Which one? ${"I can say more about each of them. ".repeat(10)}`)).toBeUndefined();
    expect(asked("Tell me which one you like and I will go on.")).toBeUndefined();
    // A few short lines between the list and the question are the answer rounding off.
    expect(asked("They differ in tone.\nBoth are short.\nWhich one?")).toBe("Which one?");
    // The question before the list is the task asking: not a closing one.
    expect(listChoiceInput("Which cuisine?\n1. Italian\n2. Japanese")?.closing).toBeUndefined();
  });

  it("reads numbered parts and a table that end on which one, as the model wrote them", () => {
    // A name in bold with its number, and a paragraph under each.
    expect(listChoiceInput("Here are three bakery names:\n\n**1. Golden Crumb**\nA warm, inviting name, which works well for branding.\n\n**2. Flour & Vine**\nGreat if you want a craft-focused vibe.\n\n**3. The Daily Loaf**\nFriendly and everyday, which makes it feel like part of the morning. Easy to say.\n\nWhich one do you prefer?"))
      .toEqual({ question: "Which one do you prefer?", options: ["Golden Crumb", "Flour & Vine", "The Daily Loaf"], allowOther: true, closing: true });
    // The name and its description on one line.
    expect(listChoiceInput("**1. Pottery** – Shaping clay into mugs and bowls. Very hands-on and meditative, and you take something home.\n\n**2. Beekeeping** – Keeping a small hive.\n\nWhich one would you like to try?")?.options).toEqual(["Pottery", "Beekeeping"]);
    // A list under each part: the parts are the options, never the last part's list.
    const films = "**1. Interstellar (2014)**\n- Tür: Bilim kurgu\n- Neden: Kozmik bir yolculuk\n\n**2. Parasite (2019)**\n- Tür: Gerilim\n- Neden: Gerginlik\n\nHangisi seni çekiyor? Ya da farklı bir türde filmler istersen söyleyebilirim.";
    expect(listChoiceInput(films)).toEqual({ question: "Hangisi seni çekiyor?", options: ["Interstellar (2014)", "Parasite (2019)"], allowOther: true, closing: true });
    expect(listChoiceInput(films.replace("Interstellar (2014)", "A".repeat(90)))).toBeNull();
    // Headings.
    expect(listChoiceInput("### 1. Kapadokya\nPeri bacaları.\n\n### 2. Bodrum\nDeniz.\n\nHangisini tercih edersin?")?.options).toEqual(["Kapadokya", "Bodrum"]);
    // A table, with a column that only counts and without.
    expect(listChoiceInput("| # | Name | Vibe |\n|---|------|------|\n| 1 | **The Daily Crumb** | Cozy |\n| 2 | **Rise & Flour** | Modern |\n\nWhich one appeals to you most? Just let me know the number."))
      .toEqual({ question: "Which one appeals to you most?", options: ["The Daily Crumb", "Rise & Flour"], allowOther: true, closing: true });
    expect(listChoiceInput("| Film | Tür |\n|---|---|\n| **Interstellar** (2014) | Bilim kurgu |\n| Parasite | Gerilim |\n\nHangi filmi izlemek istersin?")?.options).toEqual(["Interstellar (2014)", "Parasite"]);
    // The same answers with an offer under them, and with nothing.
    expect(listChoiceInput(films.replace(/Hangisi seni.*$/, "Daha fazla öneri ister misin?"))).toBeNull();
    expect(listChoiceInput("| Film | Tür |\n|---|---|\n| A | x |\n| B | y |\n\nWant more like these?")).toBeNull();
    expect(listChoiceInput("**1. Pottery** – clay.\n**2. Beekeeping** – bees.")).toBeNull();
    // Numbers that do not run from one: not parts of one answer.
    expect(listChoiceInput("**2. Pottery**\nClay.\n\n**5. Beekeeping**\nBees.\n\nWhich one?")).toBeNull();
    // A page of other things after the last part.
    expect(listChoiceInput(`**1. Pottery**\nClay.\n\n**2. Beekeeping**\nBees.\n\n${"Hobbies are good for you in many ways, as studies say. ".repeat(14)}\nMore could be said.\nWhich one?`)).toBeNull();
  });

  it("does not wait on a question that comes after the answer, with options of its own", () => {
    // Live: three kinds of music as asked, then a question nobody asked for.
    const answer = "Çalışırken şunlar iyi gider:\n\n1. **Lo-fi** – hafif ve akışkan.\n2. **Ambient** – sessiz ve sakin.\n3. **Minimal klasik** – derin ve odaklı.\n\n";
    expect(listChoiceInput(`${answer}Hangi tarz senin çalışmanla daha iyi uyum sağlar?\n\n- Daha hafif: Lo-fi\n- Daha sakin: Ambient`))
      .toEqual({ question: "Hangi tarz senin çalışmanla daha iyi uyum sağlar?", options: ["Daha hafif: Lo-fi", "Daha sakin: Ambient"], allowOther: true, closing: true });
    // However long the answer was.
    expect(listChoiceInput(`${"Bir not: müzik zevki kişiden kişiye değişir. ".repeat(8)}\n${answer}Hangisinden başlayalım?\n- Lo-fi\n- Ambient`)?.closing).toBe(true);
    // With no list before it, the question is the task asking, and that waits.
    expect(listChoiceInput("Önce sorayım: hangi tarzı seversin?\n- Lo-fi\n- Ambient")).toEqual({ question: "Önce sorayım: hangi tarzı seversin?", options: ["Lo-fi", "Ambient"], allowOther: true });
  });

  it("reads an item with a list of its own under it as one item", () => {
    const text = "Üç fikir:\n\n1. **Kahve seti**\n   - Günlük kullanışlı\n   - Fiyat: ~400 TL\n2. **Plak**\n   - Müziksever için\n\nHangisi sana daha yakın geliyor? Seçtiğini söyle, detaylandırayım.";
    expect(listChoiceInput(text)).toEqual({ question: "Hangisi sana daha yakın geliyor?", options: ["Kahve seti", "Plak"], allowOther: true, closing: true });
    // A list that is indented as a whole is still a list.
    expect(listChoiceInput("Evde mi apartmanda mı?\n  - Evde\n  - Apartmanda")?.options).toEqual(["Evde", "Apartmanda"]);
  });

  it("bounds content and rejects incomplete choices", () => {
    expect(prepareChoice("ask_choice", { question: "?", options: ["one"] }, evidence)).toHaveProperty("error");
    const result = prepareChoice("ask_choice", { question: "Q".repeat(210), options: ["A".repeat(90), "B", "C", "D", "E", "F", "G", "H", "I", "J"] }, evidence);
    expect("card" in result && result.card.kind === "choice" && result.card.question.length).toBe(200);
    expect("card" in result && result.card.kind === "choice" && result.card.options).toHaveLength(8);
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

  it("ends on a list with a question under it, and offers the items as replies", async () => {
    const text = "Three names:\n\n1. **Golden Crumb** – warm.\n2. **The Daily Rise** – fresh.\n3. **Flour & Hearth** – cozy.\n\nWhich one do you like? I can refine it.";
    const run = async (said: string) => {
      const { chat, seen } = model([{ text: said }, { text: "unreached" }]);
      const registry = new ToolRegistry();
      for (const tool of choiceTools()) registry.register(tool);
      const events: AgentEvent[] = [];
      let asked = 0;
      const result = await runAgent({ goal: "Suggest three names for a bakery", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => { asked++; return { text: "", index: 0 }; } });
      return { result, events, asked, requests: seen.length };
    };
    const closing = await run(text);
    // The answer stands as written, in one request, and nothing waited on a pick.
    expect(closing.result).toMatchObject({ status: "done", detail: text });
    expect(closing.requests).toBe(1);
    expect(closing.asked).toBe(0);
    expect(closing.events.some((event) => event.type === "choice.asked")).toBe(false);
    const step = closing.events.find((event) => event.type === "step.started");
    expect(closing.events).toContainEqual(expect.objectContaining({ type: "replies.offered", stepId: step?.type === "step.started" && step.stepId, options: ["Golden Crumb", "The Daily Rise", "Flour & Hearth"] }));
    // An offer under the same list: an answer, and nothing to click.
    const offer = await run(text.replace("Which one do you like? I can refine it.", "Want me to try more?"));
    expect(offer.result.status).toBe("done");
    expect(offer.events.some((event) => event.type === "replies.offered" || event.type === "choice.asked")).toBe(false);
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

  it("reads a table with a row per feature by its columns", async () => {
    const features = "| Feature | 13-inch | 15-inch |\n|---|---|---|\n| **Weight** | 1.2 kg | 1.8 kg |\n| Price | £900 | £1,100 |";
    // Read row by row, this table's options would be Weight and Price.
    expect(tableChoiceInput(features)).toEqual({ items: [
      { title: "13-inch", price: "£900", facts: [{ label: "Weight", value: "1.2 kg" }] },
      { title: "15-inch", price: "£1,100", facts: [{ label: "Weight", value: "1.8 kg" }] },
    ] });
    const { chat, seen } = model([{ text: features }, { text: "The 13-inch it is." }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Compare two laptops", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result.status).toBe("done");
    expect(seen).toHaveLength(2);
    expect(events.filter((event) => event.type === "choice.asked")).toMatchObject([{ card: { kind: "options", items: [{ title: "13-inch" }, { title: "15-inch" }] } }]);
  });

  it("makes cards from a priced table that numbers its rows, when the request asked for cards", async () => {
    const table = "| # | Title | Price | Use |\n|---|---|---|---|\n| 1 | **Dutch oven** | £130 | Stews |\n| 2 | Knife | £90 | Daily |";
    expect(tableChoiceInput(table)?.items).toEqual([
      { title: "Dutch oven", price: "£130", facts: [{ label: "Use", value: "Stews" }] },
      { title: "Knife", price: "£90", facts: [{ label: "Use", value: "Daily" }] },
    ]);
    const { chat, seen } = model([{ text: table }, { text: "The Dutch oven it is." }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    await runAgent({ goal: "Two gift ideas for a cook as option cards", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(seen).toHaveLength(2);
    expect(events.filter((event) => event.type === "choice.asked")).toMatchObject([{ card: { kind: "options", items: [{ title: "Dutch oven" }, { title: "Knife" }] } }]);
  });

  it("tells which way round a table runs from the request, and asks the model when nothing says", async () => {
    const byColumn = "| | Tea | Coffee |\n|---|---|---|\n| Caffeine | Less | More |\n| Taste | Mild | Strong |";
    expect(tableChoiceInput(byColumn)?.items.map((item) => item.title)).toEqual(["Tea", "Coffee"]);
    const unsaid = "| Drink | Caffeine | Taste |\n|---|---|---|\n| Tea | Less | Mild |\n| Coffee | More | Strong |";
    expect(tableChoiceInput(unsaid)).toBeNull();
    expect(tableChoiceInput(unsaid, "Compare tea and coffee")?.items.map((item) => item.title)).toEqual(["Tea", "Coffee"]);
    expect(tableChoiceInput("| Aspect | Tea | Coffee |\n|---|---|---|\n| Caffeine | Less | More |\n| Taste | Mild | Strong |", "Compare tea and coffee")?.items.map((item) => item.title)).toEqual(["Tea", "Coffee"]);
    expect(comparisonTable(unsaid)).toBe(true);
    const cards = '{"items":[{"title":"Tea","facts":[{"label":"Taste","value":"Mild"}]},{"title":"Coffee","facts":[{"label":"Taste","value":"Strong"}]}]}';
    const { chat, seen } = model([{ text: unsaid }, { calls: [{ name: "present_options", argumentsText: cards }] }, { text: "Tea it is." }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    await runAgent({ goal: "Compare two hot drinks", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(seen[1]!.messages.at(-1)!.content).toContain("plain text table");
    expect(events.filter((event) => event.type === "choice.asked")).toHaveLength(1);
  });

  it("lets a compared table stand when the model, asked once, still makes no cards", async () => {
    const features = "| Drink | Caffeine | Taste |\n|---|---|---|\n| Tea | Less | Mild |\n| Coffee | More | Strong |";
    const { chat } = model([{ text: features }, { text: features }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const result = await runAgent({ goal: "Compare two hot drinks", model: chat, tools: registry, emit: () => {}, requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result).toMatchObject({ status: "done", detail: features });
  });

  it("takes a question before its list in the shapes the model wrote it", () => {
    // Seven options, the lead-in on the question's own line, an "other" behind an emoji.
    expect(listChoiceInput("Hangi tür kitaplar ilgini çeker? Seçeneklerim:\n\n- Roman\n- Bilim kurgu\n- Gizem\n- Tarih\n- Felsefe\n- Mizah\n- Şiir\n- 🤖 Başka bir tür"))
      .toEqual({ question: "Hangi tür kitaplar ilgini çeker?", options: ["Roman", "Bilim kurgu", "Gizem", "Tarih", "Felsefe", "Mizah", "Şiir"], allowOther: true });
    // A lead-in between the question and the list, and a sentence after it.
    expect(listChoiceInput("Önce sorayım: **Bütçeniz ne kadar?**\n\nÖrneğin:\n- 100₺ – 500₺\n- 500₺ – 1.000₺\n\nYa da tam bir rakam yazabilirsiniz. Sonra ilgi alanlarına göre öneririm."))
      .toEqual({ question: "Önce sorayım: Bütçeniz ne kadar?", options: ["100₺ – 500₺", "500₺ – 1.000₺"], allowOther: true });
    // Each option explained under it, its name ending in a colon.
    expect(listChoiceInput("Evde mi, apartmanda mı yaşıyorsun?\n\nNeden önemli:\n\n- **Evde:** daha geniş alan\n  bahçe de olabilir\n- **Apartmanda:** alan kısıtlı")?.options).toEqual(["Evde", "Apartmanda"]);
    // Lettered like a quiz.
    expect(listChoiceInput("Şu an nasıl bir ruh halindesin?\n\n**A)** Rahatlamak istiyorum\n**B)** Heyecan arıyorum\nC) Düşünmek istiyorum")?.options).toEqual(["Rahatlamak istiyorum", "Heyecan arıyorum", "Düşünmek istiyorum"]);
    // A page of text after the list is an answer going on, not a question.
    expect(listChoiceInput(`Which one?\n- Ramen\n- Tacos\n${"Here is more about each of them. ".repeat(15)}`)).toBeNull();
    expect(listChoiceInput("The benefits are:\n- Health\n- Mood\n\nWalking is easy to start.")).toBeNull();
  });

  it("knows a turn that is only a short question", () => {
    expect(bareQuestion("Sure! What kind of cuisine would you like for your dinner?")).toBe(true);
    expect(bareQuestion("Merhaba!\n\nNe kadarlık bir hediye düşünüyorsun?")).toBe(true);
    expect(bareQuestion("Canberra.")).toBe(false);
    expect(bareQuestion("Which cuisine?\n1. Italian\n2. Japanese\nWhich one?")).toBe(false);
    expect(bareQuestion(`${"Here are four tips for better sleep. ".repeat(8)}Would you like more?`)).toBe(false);
  });

  it("asks once for buttons when the task opens with a plain question", async () => {
    const { chat, seen } = model([
      { text: "Sure! What kind of cuisine would you like?" },
      { calls: [{ name: "ask_choice", argumentsText: '{"question":"Which cuisine?","options":["Italian","Japanese"]}' }] },
      { text: "Here is a pasta recipe." },
    ]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "A dinner recipe; ask me the cuisine first", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result.status).toBe("done");
    expect(seen[1]!.messages.at(-1)!.content).toContain("ask it with ask_choice");
    // The buttons stand in for the question written before them.
    const first = events.find((event) => event.type === "step.started");
    const asked = events.find((event) => event.type === "choice.asked");
    expect(first?.type === "step.started" && asked?.type === "choice.asked" && asked.card.kind === "choice" && asked.replaces === first.stepId).toBe(true);
  });

  it("keeps a plain question that has no short answers, and asks about it only once", async () => {
    const { chat, seen } = model([{ text: "What is the recipient's address?" }, { text: "What is the recipient's address?" }]);
    const registry = new ToolRegistry();
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Send a card to my aunt", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result).toMatchObject({ status: "done", detail: "What is the recipient's address?" });
    expect(seen).toHaveLength(2);
    expect(events.some((event) => event.type === "choice.asked")).toBe(false);
  });

  it("refuses a third question in a row, and counts again after other work", async () => {
    const ask = (question: string) => ({ calls: [{ name: "ask_choice", argumentsText: JSON.stringify({ question, options: ["A", "B"] }) }] });
    const { chat, seen } = model([ask("Where?"), ask("When?"), ask("How many?"), { calls: [{ name: "lookup", argumentsText: "{}" }] }, ask("Which one?"), { text: "Done." }]);
    const registry = new ToolRegistry().register({ name: "lookup", description: "look up", parameters: { type: "object", properties: {} }, actionClass: "read", run: async () => "found" });
    for (const tool of choiceTools()) registry.register(tool);
    const events: AgentEvent[] = [];
    const result = await runAgent({ goal: "Lunch options", model: chat, tools: registry, emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }), requestChoice: async () => ({ text: "", index: 0 }) });
    expect(result.status).toBe("done");
    expect(events.filter((event) => event.type === "choice.asked").map((event) => event.type === "choice.asked" && event.card.kind === "choice" && event.card.question)).toEqual(["Where?", "When?", "Which one?"]);
    expect(seen[3]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Do not ask another") });
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
