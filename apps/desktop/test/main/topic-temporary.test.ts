/**
 * A temporary topic (topics/store.ts): made by Vunemi for a web lookup in a
 * conversation with no topic, marked in topic.md until the user keeps it.
 * Synthetic names only.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TopicStore } from "../../src/main/topics/store.js";

let base = "";
let store: TopicStore;
const open = () => new TopicStore({ root: () => join(base, "Memory"), dataDir: join(base, "data"), now: () => Date.UTC(2026, 10, 24) });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vunemi-temp-topic-"));
  store = open();
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

it("makes a temporary topic and reads the mark back", () => {
  expect(store.createTopic("Job hunt", "Jobs found on the web.", { temporary: true }).temporary).toBe(true);
  expect(store.createTopic("Garden", "Roses.").temporary).toBeUndefined();
  store.close();
  store = open();
  expect(store.findTopic("Job hunt")?.temporary).toBe(true);
  expect(store.findTopic("Garden")?.temporary).toBeUndefined();
});

it("keeps it: the mark goes, the notes stay", () => {
  store.createTopic("Job hunt", "Jobs.", { temporary: true });
  store.writeNote("Job hunt", { title: "Analyst, Beta", text: "35,000 in Leeds", by: "vunemi", sources: [] });
  const kept = store.keepTopic("Job hunt");
  expect(kept.temporary).toBeUndefined();
  expect(kept.about).toBe("Jobs.");
  expect(store.readNote("Job hunt", "Analyst, Beta")?.text).toBe("35,000 in Leeds");
});

it("keeps it under a new name: folder, topic.md and search follow", () => {
  store.createTopic("Job hunt", "Jobs.", { temporary: true });
  store.writeNote("Job hunt", { title: "Analyst, Beta", text: "35,000 in Leeds", by: "vunemi", sources: [] });
  const kept = store.keepTopic("Job hunt", "Python jobs");
  expect(kept.name).toBe("Python jobs");
  expect(store.findTopic("Job hunt")).toBeNull();
  expect(existsSync(join(base, "Memory", "Job hunt"))).toBe(false);
  expect(store.readNote("Python jobs", "Analyst, Beta")?.text).toBe("35,000 in Leeds");
  expect(store.search("Leeds", "Python jobs").map((h) => h.title)).toContain("Analyst, Beta");
  expect(store.search("Leeds").every((h) => h.topic === "Python jobs")).toBe(true);
});

it("refuses a taken or bad name and changes nothing", () => {
  store.createTopic("Job hunt", "Jobs.", { temporary: true });
  store.createTopic("Garden", "Roses.");
  expect(() => store.keepTopic("Job hunt", "garden")).toThrow(/already a topic/);
  expect(() => store.keepTopic("Job hunt", "Jobs/London")).toThrow(/can't contain/);
  expect(store.findTopic("Job hunt")?.temporary).toBe(true);
});

it("gives (2) when the name is taken, any case", () => {
  store.createTopic("Job hunt", "");
  expect(store.freeTopicName("job HUNT")).toBe("job HUNT (2)");
  store.createTopic("job hunt (2)", "");
  expect(store.freeTopicName("Job hunt")).toBe("Job hunt (3)");
  expect(store.freeTopicName("Garden")).toBe("Garden");
});
