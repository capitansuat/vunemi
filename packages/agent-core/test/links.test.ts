import { describe, expect, it } from "vitest";
import { runAgent, ToolRegistry, type AgentEvent, type ChatModel, type ChatRequest, type ChatResult } from "../src/index.js";
import { addressesIn, unseenLinks } from "../src/links.js";

describe("addresses in a text", () => {
  it("are read without the punctuation around them", () => {
    const seen = addressesIn("Read https://Example.com/a/. Then (see https://example.com/b), and https://en.wikipedia.org/wiki/Rust_(programming_language)! Also http://www.example.org/?q=1#top");
    expect([...seen].sort()).toEqual(["en.wikipedia.org/wiki/Rust_(programming_language)", "example.com/a", "example.com/b", "example.org?q=1"]);
  });
});

describe("links an answer makes", () => {
  const seen = addressesIn("[tab 1] Shop — https://shop.example/laptops/air-13\nPrice 999\nMore at https://shop.example/laptops/air-15?ref=list.");

  it("are seen when the conversation held their address, whatever the scheme, www or closing slash", () => {
    expect(unseenLinks("See [the 13-inch](https://www.shop.example/laptops/air-13/) and [the 15-inch](https://shop.example/laptops/air-15?ref=list).", seen)).toEqual([]);
  });

  it("are unseen when the address was written from memory", () => {
    expect(unseenLinks("See [the 13-inch](https://shop.example/laptops/air-13) or [the maker](https://maker.example/air/specs).", seen)).toEqual(["https://maker.example/air/specs"]);
    // A page that was seen, with a path that was not.
    expect(unseenLinks("[Returns](https://shop.example/help/returns)", seen)).toEqual(["https://shop.example/help/returns"]);
    expect(unseenLinks("[One](https://maker.example/a) and again [one](https://maker.example/a)", seen)).toEqual(["https://maker.example/a"]);
  });

  it("lets through the front page of a site that was seen, and not of one that was not", () => {
    expect(unseenLinks("[The shop](https://shop.example/) and [another](https://other.example)", seen)).toEqual(["https://other.example"]);
  });

  it("looks only at what the user can click", () => {
    expect(unseenLinks("Plain https://maker.example/x and [not https](http://maker.example/y)", seen)).toEqual([]);
  });
});

describe("an answer's links, in a run", () => {
  const scripted = (turns: { calls?: { name: string; argumentsText: string }[]; text?: string }[]): ChatModel => {
    let n = 0;
    return { id: "fake:links", async chat(_req: ChatRequest): Promise<ChatResult> {
      const turn = turns[n++];
      if (!turn) throw new Error("Script exhausted");
      return { text: turn.text ?? "", toolCalls: (turn.calls ?? []).map((call, i) => ({ ...call, id: `call-${n}-${i}` })), usage: { promptTokens: 1, completionTokens: 1, ttftMs: 1, tokensPerSec: 1 } };
    } };
  };
  const lookup = () => new ToolRegistry().register({
    name: "lookup", description: "look up", parameters: { type: "object", properties: {} }, actionClass: "read", untrustedOutput: true,
    run: async () => "Found at https://shop.example/laptops/air-13 for 999.",
  });
  const run = async (goal: string, answer: string, history: { role: "user" | "assistant"; content: string }[] = []) => {
    const events: AgentEvent[] = [];
    await runAgent({ goal, history, model: scripted([{ calls: [{ name: "lookup", argumentsText: "{}" }] }, { text: answer }]), tools: lookup(), emit: (event) => events.push(event), requestApproval: async () => ({ kind: "approve" }) });
    return events.flatMap((event) => (event.type === "links.unverified" ? [event.urls] : []));
  };

  it("names the ones no tool returned and the user did not write", async () => {
    expect(await run("Find the 13-inch", "It is [here](https://shop.example/laptops/air-13); specs at [the maker](https://maker.example/specs).")).toEqual([["https://maker.example/specs"]]);
  });

  it("says nothing when every link was seen, in a tool's output or in what the user wrote", async () => {
    expect(await run("Find the 13-inch", "It is [here](https://shop.example/laptops/air-13).")).toEqual([]);
    expect(await run("Is https://maker.example/specs right about the 13-inch?", "Yes: [the maker](https://maker.example/specs).")).toEqual([]);
    expect(await run("And the 13-inch?", "As before: [the maker](https://maker.example/specs).", [{ role: "user", content: "Look at https://maker.example/specs" }, { role: "assistant", content: "Looked." }])).toEqual([]);
  });

  it("does not take an earlier answer's link for a seen one", async () => {
    expect(await run("And the 13-inch?", "See [the maker](https://maker.example/specs).", [{ role: "user", content: "Where are the specs?" }, { role: "assistant", content: "At [the maker](https://maker.example/specs)." }])).toEqual([["https://maker.example/specs"]]);
  });
});
