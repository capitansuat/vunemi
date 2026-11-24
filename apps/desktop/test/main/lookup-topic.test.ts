/**
 * A web lookup in a conversation with no topic gathers in a temporary topic
 * (topics/lookup-topic.ts): its answer, with the addresses it read, as a page.
 * Synthetic pages and hosts only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { TopicStore } from "../../src/main/topics/store.js";
import { answerPageText, pageAddress, temporaryTopic, writeAnswer } from "../../src/main/topics/lookup-topic.js";

let base = "";
let topics: TopicStore;
let linked: string[];
beforeEach(() => {
  setLocale("en");
  base = mkdtempSync(join(tmpdir(), "vunemi-lookup-topic-"));
  topics = new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data"), now: () => Date.UTC(2026, 10, 24) });
  linked = [];
});
afterEach(() => {
  topics.close();
  rmSync(base, { recursive: true, force: true });
});

const ask = (over: Partial<Parameters<typeof temporaryTopic>[0]> = {}) =>
  temporaryTopic({ topics, conversation: { declined: false }, proposed: "Accountant jobs in London", request: "Find accountant jobs", link: (name) => linked.push(name), ...over });

describe("pageAddress", () => {
  it("reads the address of a page view", () => {
    expect(pageAddress("Now on: [tab 1] Jobs — https://jobs.example/x\n\n# Jobs\n- Analyst")).toBe("https://jobs.example/x");
    expect(pageAddress("[tab 2] Search — http://jobs.example/search?q=a b")).toBe("http://jobs.example/search?q=a");
    expect(pageAddress("Scrolled down.")).toBeNull();
  });
});

describe("answerPageText", () => {
  it("writes the answer with its sources", () => {
    expect(answerPageText("Two jobs:\n- Analyst, Beta", ["https://jobs.example/1", "https://jobs.example/2"], 4_000)).toBe(
      "Two jobs:\n- Analyst, Beta\n\nSources:\n- https://jobs.example/1\n- https://jobs.example/2",
    );
    expect(answerPageText("No jobs found.", [], 4_000)).toBe("No jobs found.");
  });

  it("cuts a long answer at a line and keeps the sources", () => {
    const answer = Array.from({ length: 30 }, (_, i) => `- Job ${i + 1}, somewhere`).join("\n");
    const text = answerPageText(answer, ["https://jobs.example/1"], 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/- Job \d+, somewhere\n…\n\nSources:\n- https:\/\/jobs\.example\/1$/);
  });
});

describe("temporaryTopic", () => {
  it("makes a temporary topic once, under the proposed name, linked to the conversation", () => {
    expect(ask()).toBe("Accountant jobs in London");
    expect(topics.findTopic("Accountant jobs in London")?.temporary).toBe(true);
    expect(linked).toEqual(["Accountant jobs in London"]);
    expect(ask({ conversation: { topic: "Accountant jobs in London", declined: false } })).toBe("Accountant jobs in London");
    expect(linked).toHaveLength(1);
  });

  it("gives (2) when the name is a topic the user has, and leaves theirs alone", () => {
    topics.createTopic("Accountant jobs in London", "Mine.");
    expect(ask()).toBe("Accountant jobs in London (2)");
    expect(topics.findTopic("Accountant jobs in London")?.temporary).toBeUndefined();
  });

  it("uses the request's first words when the model gave no name", () => {
    expect(ask({ proposed: "", request: "Find accountant jobs in London that pay at least 35,000 a year and are full time" })).toBe("Find accountant jobs in London that pay");
  });

  it("makes none when the user deleted it in this conversation", () => {
    expect(ask({ conversation: { declined: true } })).toBeNull();
    expect(topics.listTopics()).toEqual([]);
  });
});

describe("writeAnswer", () => {
  const write = (answer: string, request = "Find accountant jobs in London") =>
    writeAnswer({ topics, topic: "Jobs", request, answer, addresses: ["https://jobs.example/1"], redact: async (s) => s.replaceAll("hunter2-secret", "[secret]") });

  beforeEach(() => topics.createTopic("Jobs", "", { temporary: true }));

  it("writes the answer as Vunemi's page, named from the request", async () => {
    expect(await write("Analyst, Beta: 35,000")).toBe("Found — Find accountant jobs in London");
    const note = topics.readNote("Jobs", "Found — Find accountant jobs in London")!;
    expect(note.by).toBe("vunemi");
    expect(note.text).toBe("Analyst, Beta: 35,000\n\nSources:\n- https://jobs.example/1");
  });

  it("gives a second answer to the same request its own page", async () => {
    await write("Analyst, Beta");
    expect(await write("Auditor, Gamma")).toBe("Found — Find accountant jobs in London (2)");
    expect(topics.readNote("Jobs", "Found — Find accountant jobs in London")!.text).toContain("Analyst, Beta");
    // The same answer again is the same page.
    expect(await write("Auditor, Gamma")).toBe("Found — Find accountant jobs in London (2)");
  });

  it("cuts a long request in the title at a word", async () => {
    expect(await write("Two jobs", "Search NHS Jobs (jobs.nhs.uk) for software developer vacancies and list the ones you find.")).toBe(
      "Found — Search NHS Jobs (jobs.nhs.uk) for software developer",
    );
  });

  it("writes nothing for an empty answer", async () => {
    expect(await write("  ")).toBeNull();
    expect(topics.outline("Jobs").notes).toEqual([]);
  });

  it("masks secrets in the answer", async () => {
    await write("Signed in with hunter2-secret; two jobs.");
    expect(topics.readNote("Jobs", "Found — Find accountant jobs in London")!.text).not.toContain("hunter2-secret");
  });
});
