/**
 * What "@" brings in. What matters: only questions and answers leave a
 * conversation, several mentions share one budget, and the window cannot
 * name anything but a conversation or meeting of ours.
 */
import type { AgentEvent } from "@vunemi/agent-core";
import { describe, expect, it } from "vitest";
import { conversationTasks, meetingParts, mentionable, mentionRefs, mentionTexts } from "../../src/main/mentions.js";
import type { MeetingSummary } from "../../src/main/meetings/store.js";
import type { SessionSummary } from "../../src/shared/ipc.js";

const MEETING = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("mentionRefs", () => {
  it("takes nothing as none", () => {
    expect(mentionRefs(undefined)).toEqual([]);
    expect(mentionRefs([])).toEqual([]);
  });

  it("passes a conversation and a meeting, with the title cut", () => {
    const refs = mentionRefs([
      { kind: "conversation", id: "s_abc123", title: "x".repeat(200), extra: 1 },
      { kind: "meeting", id: MEETING, title: "Sync" },
    ]);
    expect(refs).toEqual([
      { kind: "conversation", id: "s_abc123", title: "x".repeat(80) },
      { kind: "meeting", id: MEETING, title: "Sync" },
    ]);
  });

  it.each([
    ["an unknown kind", [{ kind: "file", id: "s_abc123", title: "a" }]],
    ["a path as an id", [{ kind: "conversation", id: "../s_abc123", title: "a" }]],
    ["a meeting id on a conversation", [{ kind: "conversation", id: MEETING, title: "a" }]],
    ["a title that is not text", [{ kind: "meeting", id: MEETING, title: 3 }]],
    ["something that is not a list", "s_abc123"],
    ["six of them", Array.from({ length: 6 }, () => ({ kind: "conversation", id: "s_abc123", title: "a" }))],
  ])("refuses %s", (_name, value) => {
    expect(() => mentionRefs(value)).toThrow("Bad mention");
  });
});

describe("mentionable", () => {
  const session = (id: string, updatedAt: number, runs = 1): SessionSummary => ({ id, title: id, updatedAt, runs });
  const meeting = (id: string, startedAt: number, state: MeetingSummary["state"] = "done"): MeetingSummary =>
    ({ id, title: "", startedAt, endedAt: null, language: null, summary: null, state });

  it("lists both kinds newest first, without the open conversation, empty ones and a meeting still recording", () => {
    const items = mentionable(
      [session("s_open01", 90), session("s_old001", 10), session("s_empty1", 80, 0), session("s_new001", 50)],
      [meeting("m-mid", 30), meeting("m-live", 99, "recording")],
      "s_open01",
    );
    expect(items).toEqual([
      { kind: "conversation", id: "s_new001", title: "s_new001", at: 50 },
      { kind: "meeting", id: "m-mid", title: "", at: 30 },
      { kind: "conversation", id: "s_old001", title: "s_old001", at: 10 },
    ]);
  });
});

describe("conversationTasks", () => {
  const started = (runId: string, goal: string): AgentEvent => ({ type: "run.started", runId, goal, model: "m", at: 1 });
  const said = (runId: string, step: number, text: string): AgentEvent => ({ type: "message.delta", runId, stepId: `${runId}.s${step}`, text });

  it("gives each task its request and its final answer, not the narration before it", () => {
    const events: AgentEvent[] = [
      started("r1", "Find a hotel in Rome"),
      said("r1", 0, "Let me look."),
      { type: "thought.delta", runId: "r1", stepId: "r1.s0", text: "SECRET THOUGHT" },
      { type: "tool.finished", runId: "r1", stepId: "r1.s0", callId: "c1", ok: true, output: "RAW PAGE", durationMs: 1 } as AgentEvent,
      said("r1", 1, "Hotel "),
      said("r1", 1, "Aurora, 120 EUR."),
      { type: "run.finished", runId: "r1", status: "done", detail: "", at: 2 } as AgentEvent,
      started("r2", "And breakfast?"),
      said("r2", 0, "Included."),
    ];
    expect(conversationTasks(events)).toEqual([
      "User: Find a hotel in Rome\nVunemi: Hotel Aurora, 120 EUR.",
      "User: And breakfast?\nVunemi: Included.",
    ]);
  });

  it("keeps a question card and the answer picked, between the request and the answer", () => {
    const events: AgentEvent[] = [
      started("r1", "Plan a trip"),
      { type: "choice.asked", runId: "r1", stepId: "r1.s0", callId: "c1", card: { kind: "choice", question: "Which city?", options: ["Rome", "Paris"], allowOther: true }, at: 1 },
      { type: "choice.answered", runId: "r1", callId: "c1", text: "Rome", index: 0, at: 2 },
      { type: "choice.asked", runId: "r1", stepId: "r1.s1", callId: "c2", card: { kind: "options", items: [] }, at: 3 },
      { type: "choice.answered", runId: "r1", callId: "c2", text: "Hotel Aurora", at: 4 },
      said("r1", 2, "Booked nothing yet; Aurora it is."),
    ];
    expect(conversationTasks(events)).toEqual([
      "User: Plan a trip\nVunemi asked: Which city?\nUser chose: Rome\nUser chose: Hotel Aurora\nVunemi: Booked nothing yet; Aurora it is.",
    ]);
  });

  it("gives a task without an answer its request alone", () => {
    expect(conversationTasks([started("r1", "Hello")])).toEqual(["User: Hello"]);
    expect(conversationTasks([])).toEqual([]);
  });
});

describe("meetingParts", () => {
  it("labels the summary and writes the words with their time and side", () => {
    const parts = meetingParts({
      summary: "  Ship on Friday.\n",
      lines: [
        { source: "me", start: 12.4, end: 15, text: "Can we ship?" },
        { source: "others", start: 65, end: 70, text: "On Friday." },
        { source: "me", start: 3723, end: 3725, text: "Thanks." },
      ],
    });
    expect(parts.summary).toBe("Summary:\nShip on Friday.");
    expect(parts.transcript).toBe("[00:12] Me: Can we ship?\n[01:05] Others: On Friday.\n[1:02:03] Me: Thanks.");
  });

  it("says so when there is no summary, and has no transcript without words", () => {
    expect(meetingParts({ summary: null, lines: [] })).toEqual({ summary: "No summary was written.", transcript: "" });
  });
});

describe("mentionTexts", () => {
  const talk = (...tasks: string[]) => ({ kind: "conversation" as const, tasks });
  const met = (summary: string, transcript: string) => ({ kind: "meeting" as const, summary, transcript });

  it("sends everything whole when it fits", () => {
    expect(mentionTexts([talk("a", "b"), null, met("S", "T")], 1000)).toEqual(["a\n\nb", null, "S\n\nTranscript:\nT"]);
  });

  it("leaves a transcript out whole when it does not fit, and still takes a smaller one after it", () => {
    const texts = mentionTexts([met("S1", "x".repeat(500)), met("S2", "y".repeat(50))], 100);
    expect(texts).toEqual(["S1\n\nThe transcript is left out: too long.", `S2\n\nTranscript:\n${"y".repeat(50)}`]);
  });

  it("shares the room between conversations, dropping the earliest tasks", () => {
    const a = talk("1".repeat(100), "2".repeat(100), "3".repeat(100), "4".repeat(60));
    const b = talk("p".repeat(100), "q".repeat(60));
    const [first = "", second = ""] = mentionTexts([a, b], 240) as string[];
    expect(first).toBe(`The 3 earliest tasks are left out: too long.\n\n${"4".repeat(60)}`);
    expect(second).toBe(`The earliest task is left out: too long.\n\n${"q".repeat(60)}`);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(second.length).toBeLessThanOrEqual(120);
  });

  it("keeps the newest task even when it alone is too long, cut to its share", () => {
    const [only = ""] = mentionTexts([talk("old", "n".repeat(500))], 100) as string[];
    expect(only).toHaveLength(100);
    expect(only.startsWith("The earliest task is left out: too long.\n\nnnn")).toBe(true);
    expect(only.endsWith("…")).toBe(true);
    const [single] = mentionTexts([talk("n".repeat(500))], 100) as string[];
    expect(single).toBe(`${"n".repeat(99)}…`);
  });

  it("gives summaries their room before conversations share the rest", () => {
    const [summary, conversation = ""] = mentionTexts([met("S".repeat(40), ""), talk("a".repeat(100), "b".repeat(30))], 120) as string[];
    expect(summary).toBe("S".repeat(40));
    expect(conversation.length).toBeLessThanOrEqual(80);
    expect(conversation.endsWith("b".repeat(30))).toBe(true);
  });
});
