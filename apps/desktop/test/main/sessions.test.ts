/**
 * Conversations, kept. What matters: a new conversation never costs the old
 * one, a reopened conversation looks and continues as it was, the files are
 * the user's alone, and a path cannot be smuggled in as an id.
 */
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ChatMessage } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldEvent } from "../../src/renderer/src/lib/fold.js";
import { appendCompacted, CLOSED_MID_CALL, CLOSED_MID_TASK, SessionStore } from "../../src/main/sessions.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-sessions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One whole task, streamed the way the agent streams it. */
function task(runId: string, goal: string, answer: string): AgentEvent[] {
  const stepId = `${runId}.s0`;
  return [
    { type: "run.started", runId, goal, model: "m", at: 1 },
    { type: "step.started", runId, stepId, index: 0, at: 2 },
    ...[..."düşünüyorum"].map((ch): AgentEvent => ({ type: "thought.delta", runId, stepId, text: ch })),
    ...[...answer].map((ch): AgentEvent => ({ type: "message.delta", runId, stepId, text: ch })),
    { type: "run.finished", runId, status: "done", detail: "", at: 3 },
  ] as AgentEvent[];
}

const history = (goal: string, answer: string): ChatMessage[] => [
  { role: "user", content: goal },
  { role: "assistant", content: answer },
];

function run(store: SessionStore, runId: string, goal: string, answer: string): void {
  for (const e of task(runId, goal, answer)) store.record(e);
  store.setHistory(history(goal, answer));
}

describe("SessionStore", () => {
  it("keeps the old conversation when a new one starts", () => {
    const store = new SessionStore(dir);
    run(store, "r1", "takvimde bugün ne var", "3 toplantı");
    const first = store.currentId;
    const second = store.create();

    expect(second).not.toBe(first);
    expect(store.list().map((s) => s.id)).toEqual([first]);
    expect(store.open(first).history).toEqual(history("takvimde bugün ne var", "3 toplantı"));
  });

  it("keeps notes proposed after the task, and the user's answer", () => {
    const store = new SessionStore(dir);
    run(store, "r1", "17 ile 25'i topla, cevapları kısa yaz", "42");
    store.record({ type: "memory.proposed", runId: "r1", proposals: [{ id: "p1", text: "Kısa cevap ister", kind: "general", quote: "cevapları kısa yaz" }], at: 4 });
    store.record({ type: "memory.resolved", runId: "r1", proposalId: "p1", decision: "saved", at: 5 });
    const events = new SessionStore(dir).open(store.currentId).events;
    expect(events.map((e) => e.type).slice(-2)).toEqual(["memory.proposed", "memory.resolved"]);
  });

  it("does not write, or list, a conversation with nothing in it", () => {
    const store = new SessionStore(dir);
    const id = store.create();
    expect(store.create()).toBe(id);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("survives a restart, newest first, titled by its first task", () => {
    let t = 100;
    const store = new SessionStore(dir, () => t);
    run(store, "r1", "eski iş", "tamam");
    t = 200;
    store.create();
    run(store, "r2", "yeni iş", "tamam");

    const again = new SessionStore(dir);
    expect(again.list().map((s) => [s.title, s.runs])).toEqual([["yeni iş", 1], ["eski iş", 1]]);
  });

  it("reopens to the same timeline, from far fewer events than were streamed", () => {
    const store = new SessionStore(dir);
    const streamed = task("r1", "özetle", "Kısa bir özet.");
    for (const e of streamed) store.record(e);
    store.setHistory(history("özetle", "Kısa bir özet."));
    const id = store.currentId;
    store.create();

    const { events } = new SessionStore(dir).open(id);
    expect(events.length).toBeLessThan(streamed.length / 4);
    expect(events.reduce(foldEvent, [])).toEqual(streamed.reduce(foldEvent, []));
  });

  it("writes the files for the user alone", () => {
    const store = new SessionStore(dir);
    run(store, "r1", "gizli iş", "tamam");
    const [file] = readdirSync(dir);
    expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
  });

  it("refuses an id that is really a path", () => {
    const store = new SessionStore(dir);
    writeFileSync(join(dir, "..", "outside.json"), "{}");
    expect(() => store.open("../outside")).toThrow(/bulunamadı/);
    store.remove("../outside");
    expect(() => statSync(join(dir, "..", "outside.json"))).not.toThrow();
    rmSync(join(dir, "..", "outside.json"));
  });

  it("forgets one conversation, and starts afresh when it was the current one", () => {
    const store = new SessionStore(dir);
    run(store, "r1", "unutulacak", "tamam");
    const id = store.currentId;
    store.remove(id);
    expect(store.list()).toEqual([]);
    expect(store.currentId).not.toBe(id);
    expect(() => store.open(id)).toThrow();
  });

  it("leaves a file it cannot read where it is", () => {
    writeFileSync(join(dir, "s_bozukdosya1.json"), "{ yarım");
    const store = new SessionStore(dir);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toContain("s_bozukdosya1.json");
  });
});

describe("appendCompacted", () => {
  it("does not join pieces of different steps", () => {
    const events: AgentEvent[] = [];
    appendCompacted(events, { type: "message.delta", runId: "r", stepId: "r.s0", text: "a" } as AgentEvent);
    appendCompacted(events, { type: "message.delta", runId: "r", stepId: "r.s1", text: "b" } as AgentEvent);
    expect(events).toHaveLength(2);
  });

  it("trims a huge tool output, keeping its start", () => {
    const events: AgentEvent[] = [];
    const output = "x".repeat(50_000);
    appendCompacted(events, { type: "tool.finished", runId: "r", callId: "c", ok: true, output, durationMs: 1 } as AgentEvent);
    const stored = events[0] as Extract<AgentEvent, { type: "tool.finished" }>;
    expect(stored.output.length).toBeLessThan(21_000);
    expect(stored.output.startsWith("xxxx")).toBe(true);
  });
});

describe("a task cut short by Vunemi closing", () => {
  /** A run that asked for two tools; the first answered, then Vunemi died. */
  function crash(store: SessionStore): string {
    run(store, "r1", "önceki", "tamam");
    const events: AgentEvent[] = [
      { type: "run.started", runId: "r2", goal: "iki not yaz", model: "m", at: 10 },
      { type: "step.started", runId: "r2", stepId: "r2.s0", index: 0, at: 11 },
    ] as AgentEvent[];
    for (const e of events) store.record(e);
    const asked: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "a", name: "save_note", argumentsText: "{}" }, { id: "b", name: "save_note", argumentsText: "{}" }] };
    const base = [...history("önceki", "tamam"), { role: "user", content: "<user_request>\niki not yaz\n</user_request>" } as ChatMessage, asked];
    store.checkpoint(base);
    store.checkpoint([...base, { role: "tool", content: "saved", toolCallId: "a", toolName: "save_note" }]);
    return store.currentId;
  }

  it("keeps nothing extra once the run ends normally", () => {
    const store = new SessionStore(dir);
    run(store, "r1", "a", "b");
    store.checkpoint(history("a", "b"));
    for (const e of task("r2", "c", "d")) store.record(e);
    expect(readdirSync(dir).filter((f) => f.endsWith(".checkpoint"))).toEqual([]);
  });

  it("comes back marked, with the finished step kept and the unfinished one unknown", () => {
    const id = crash(new SessionStore(dir));
    expect(statSync(join(dir, `${id}.checkpoint`)).mode & 0o777).toBe(0o600);

    const next = new SessionStore(dir);
    expect(readdirSync(dir).filter((f) => f.endsWith(".checkpoint"))).toEqual([]);
    expect(next.interrupted).toEqual([id]);
    expect(next.list().find((s) => s.id === id)?.interrupted?.steps).toBe(1);

    const { history: kept, events } = next.open(id);
    const tools = kept.filter((m) => m.role === "tool");
    expect(tools.map((m) => [m.toolCallId, m.content])).toEqual([["a", "saved"], ["b", CLOSED_MID_CALL]]);
    expect(kept.at(-1)).toEqual({ role: "assistant", content: CLOSED_MID_TASK });
    // The timeline gets the ending it never had, and both tasks are still there.
    const runs = events.reduce(foldEvent, []);
    expect(runs.map((r) => [r.runId, r.status])).toEqual([["r1", "done"], ["r2", "stopped"]]);
  });

  it("clears the mark when the user lets it go or starts another task", () => {
    const id = crash(new SessionStore(dir));
    const store = new SessionStore(dir);
    store.open(id);
    store.dismissInterrupted();
    expect(new SessionStore(dir).interrupted).toEqual([]);

    const again = crash(new SessionStore(dir));
    const other = new SessionStore(dir);
    other.open(again);
    for (const e of task("r3", "devam", "bitti")) other.record(e);
    expect(new SessionStore(dir).interrupted).toEqual([]);
  });

  it("forgets the checkpoint with the conversation, and leaves an unreadable one alone", () => {
    const store = new SessionStore(dir);
    const id = crash(store);
    store.remove(id);
    expect(readdirSync(dir).filter((f) => f.startsWith(id))).toEqual([]);

    writeFileSync(join(dir, "s_broken123.checkpoint"), "{nope");
    expect(new SessionStore(dir).interrupted).toEqual([]);
    expect(readdirSync(dir)).toContain("s_broken123.checkpoint");
  });
});
