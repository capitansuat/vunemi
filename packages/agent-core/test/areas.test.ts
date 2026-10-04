import { describe, expect, it } from "vitest";
import { pickAreas, unwrapRun, type ToolArea } from "../src/areas.js";
import type { ChatModel } from "../src/provider.js";

const AREAS: ToolArea[] = [
  { id: "mail", summary: "the user's mail" },
  { id: "calendar", summary: "calendar and reminders" },
  { id: "browser", summary: "the web" },
];
const model = (odds: Record<string, number> | null): ChatModel & { asked: string[] } => {
  const asked: string[] = [];
  return {
    id: "fake", asked,
    chat: async () => { throw new Error("no chat"); },
    firstTokenOdds: async (messages, candidates) => { asked.push(messages.at(-1)!.content, candidates.join("")); return odds; },
  };
};

describe("pickAreas", () => {
  it("asks once, with a letter per area and one for no tools", async () => {
    const m = model({ A: 0, B: 1, C: 0, D: 0 });
    expect(await pickAreas(m, "Find Ahmet's mail", AREAS)).toEqual(["mail"]);
    expect(m.asked[0]).toContain("Request: Find Ahmet's mail");
    expect(m.asked[0]).toContain("B) the user's mail");
    expect(m.asked[1]).toBe("ABCD");
  });

  it("takes every area with a real share, most likely first, at most three", async () => {
    expect(await pickAreas(model({ A: 0, B: 0.55, C: 0.3, D: 0.15 }), "g", AREAS)).toEqual(["mail", "calendar", "browser"]);
    expect(await pickAreas(model({ A: 0, B: 0.9, C: 0.1, D: 0 }), "g", AREAS)).toEqual(["mail"]);
  });

  it("picks nothing when no tools is the likeliest answer", async () => {
    expect(await pickAreas(model({ A: 0.7, B: 0.3, C: 0, D: 0 }), "g", AREAS)).toEqual([]);
  });

  it("can't tell without odds", async () => {
    expect(await pickAreas(model(null), "g", AREAS)).toBeNull();
    expect(await pickAreas({ id: "x", chat: async () => { throw new Error(); } }, "g", AREAS)).toBeNull();
  });
});

describe("unwrapRun", () => {
  it("reads the call it stands for", () => {
    expect(unwrapRun('{"name":"mail_read","arguments":{"id":"7"}}')).toEqual({ name: "mail_read", argumentsText: '{"id":"7"}' });
    expect(unwrapRun('{"name":"mail_read","arguments":"{\\"id\\":\\"7\\"}"}')).toEqual({ name: "mail_read", argumentsText: '{"id":"7"}' });
    expect(unwrapRun('{"name":"mail_read"}')).toEqual({ name: "mail_read", argumentsText: "{}" });
    expect(unwrapRun("not json")).toHaveProperty("error");
  });
});
