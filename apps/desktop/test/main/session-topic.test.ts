/** A conversation remembers the topic it is in, like its project, and whether Vunemi already asked. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/main/sessions.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-session-topic-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const oneTask = (store: SessionStore) => {
  store.record({ type: "run.started", runId: "r1", goal: "Tile offers", at: 1 } as never);
  store.record({ type: "run.finished", runId: "r1", status: "done", at: 2 } as never);
};

describe("a conversation in a topic", () => {
  it("keeps its topic, in the list and after reopening", () => {
    const store = new SessionStore(join(dir, "sessions"));
    store.setTopic("Home renovation");
    oneTask(store);
    const id = store.currentId;
    expect(store.list()[0]!.topic).toBe("Home renovation");
    store.create();
    expect(store.currentTopic).toBeUndefined();
    expect(store.topicAsked).toBe(false);
    store.open(id);
    expect(store.currentTopic).toBe("Home renovation");
    expect(store.topicAsked).toBe(true);
  });

  it("is asked once: a no is remembered too", () => {
    const store = new SessionStore(join(dir, "sessions"));
    oneTask(store);
    store.markTopicAsked();
    const id = store.currentId;
    const again = new SessionStore(join(dir, "sessions"));
    again.open(id);
    expect(again.topicAsked).toBe(true);
    expect(again.currentTopic).toBeUndefined();
  });

  it("remembers that the user deleted its temporary topic, also after reopening and recovery", () => {
    const store = new SessionStore(join(dir, "sessions"));
    oneTask(store);
    expect(store.temporaryDeclined).toBe(false);
    store.setTopic("Job hunt");
    store.declineTemporary();
    expect(store.currentTopic).toBeUndefined();
    expect(store.temporaryDeclined).toBe(true);
    const id = store.currentId;
    const again = new SessionStore(join(dir, "sessions"));
    again.open(id);
    expect(again.temporaryDeclined).toBe(true);
    again.record({ type: "run.started", runId: "r2", goal: "More jobs", at: 3 } as never);
    again.checkpoint([{ role: "user", content: "<user_request>More jobs</user_request>" }] as never);
    const next = new SessionStore(join(dir, "sessions"));
    next.open(id);
    expect(next.temporaryDeclined).toBe(true);
    next.create();
    expect(next.temporaryDeclined).toBe(false);
  });

  it("can leave its topic", () => {
    const store = new SessionStore(join(dir, "sessions"));
    store.setTopic("Home renovation");
    store.setTopic(null);
    expect(store.currentTopic).toBeUndefined();
  });

  it("keeps its topic when a task cut short is recovered", () => {
    const first = new SessionStore(join(dir, "sessions"));
    first.setTopic("Home renovation");
    first.record({ type: "run.started", runId: "r1", goal: "Tile offers", at: 1 } as never);
    first.checkpoint([{ role: "user", content: "<user_request>Tile offers</user_request>" }] as never);
    const id = first.currentId;
    const next = new SessionStore(join(dir, "sessions"));
    expect(next.list().find((s) => s.id === id)?.topic).toBe("Home renovation");
  });

  it("follows its topic when it is renamed, and leaves it when it is gone", () => {
    const store = new SessionStore(join(dir, "sessions"));
    store.setTopic("Home renovation");
    oneTask(store);
    const id = store.currentId;
    store.create();
    store.renameTopic("home renovation", "Renovation 2026");
    expect(store.list().find((s) => s.id === id)?.topic).toBe("Renovation 2026");
    store.renameTopic("Renovation 2026", null);
    expect(store.list().find((s) => s.id === id)?.topic).toBeUndefined();
  });
});
