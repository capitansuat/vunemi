/**
 * A meeting end to end with stand-ins: the fake recorder writes PCM, a fake
 * whisper writes words, a fake model writes the summary.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatModel } from "@vunemi/agent-core";
import { Recorder } from "../../src/main/meetings/recorder.js";
import { RATE } from "../../src/main/meetings/segmenter.js";
import { MeetingService, type MeetingStatus } from "../../src/main/meetings/service.js";
import type { Turn } from "../../src/main/meetings/speakers.js";
import { MeetingStore } from "../../src/main/meetings/store.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-recorder.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const speech = (seconds: number) => {
  const out = Buffer.alloc(Math.round(seconds * RATE) * 2);
  for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return out;
};

const SUMMARY = JSON.stringify({ title: "Plan", summary: "Konuşuldu.", decisions: [], actions: [], questions: [] });

let root: string;
let store: MeetingStore;
let recorder: Recorder;
let statuses: MeetingStatus[];
let modelAnswer: () => string;
let transcriptionFails: boolean;
/** What telling the others apart answers; null leaves it switched off. */
let turns: (() => Promise<Turn[]>) | null;
/** Everything the model was asked. */
let asked: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vunemi-service-"));
  store = new MeetingStore(join(root, "meetings"), async (path) => rmSync(path, { recursive: true }));
  recorder = new Recorder(FAKE);
  statuses = [];
  modelAnswer = () => SUMMARY;
  transcriptionFails = false;
  turns = null;
  asked = "";
  delete process.env.FAKE_RECORDER_MODE;
});
afterEach(() => {
  recorder.dispose();
  rmSync(root, { recursive: true, force: true });
});

function service(blocked: () => "macos" | null = () => null) {
  const model: ChatModel = {
    id: "fake",
    chat: async (request) => {
      asked += JSON.stringify(request.messages);
      const text = modelAnswer();
      return { text, toolCalls: [], usage: { promptTokens: null, completionTokens: null, ttftMs: null, tokensPerSec: null } };
    },
  };
  return new MeetingService({
    store,
    recorder,
    transcribe: async () => {
      if (transcriptionFails) throw new Error("whisper unavailable");
      return { text: "Bütçeyi konuştuk.", language: "tr", noSpeech: 0 };
    },
    model: async () => ({ model, window: 8_000 }),
    words: () => ({ names: { me: "Ben", others: "Diğerleri", person: (n: number) => `Kişi ${n}` }, headings: { summary: "Özet", decisions: "Kararlar", actions: "Yapılacaklar", questions: "Sorular" }, language: "Turkish" }),
    blocked,
    onChange: (s) => statuses.push(s),
    onLine: () => {},
    ...(turns && { speakers: { ready: () => true, turns: () => turns!() } }),
  });
}

describe("MeetingService", () => {
  it("records, writes down, summarises and sends the audio to the Trash", async () => {
    const s = service();
    const meeting = await s.start();
    expect(s.status().recording?.id).toBe(meeting.id);
    // What the recorder would have written during the meeting.
    writeFileSync(join(store.folder(meeting.id), "system.pcm"), speech(1.5));
    await s.stop("lmstudio:m");
    const done = store.get(meeting.id)!;
    expect(done.state).toBe("done");
    expect(done.title).toBe("Plan");
    expect(done.lines).toEqual([expect.objectContaining({ source: "others", text: "Bütçeyi konuştuk." })]);
    expect(done.summary).toContain("## Özet");
    expect(done.language).toBeNull(); // under a minute: not settled
    expect(existsSync(join(store.folder(meeting.id), "system.pcm"))).toBe(false);
    expect(s.status().recording).toBeNull();
  });

  it("keeps the transcript when the summary fails, and tries again", async () => {
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "mic.pcm"), speech(1));
    modelAnswer = () => {
      throw new Error("model gone");
    };
    await s.stop("lmstudio:m");
    let m = store.get(meeting.id)!;
    expect(m).toMatchObject({ state: "failed", error: "model gone" });
    expect(m.lines).toHaveLength(1);
    expect(existsSync(join(store.folder(meeting.id), "mic.pcm"))).toBe(true);

    modelAnswer = () => SUMMARY;
    await s.retry(meeting.id, "lmstudio:m");
    m = store.get(meeting.id)!;
    expect(m.state).toBe("done");
    expect(m.lines).toHaveLength(1);
  });

  it("fails without a model, and does not start a second recording", async () => {
    const s = service();
    const meeting = await s.start();
    await expect(s.start()).rejects.toThrow("already");
    writeFileSync(join(store.folder(meeting.id), "mic.pcm"), speech(1));
    await s.stop(null);
    expect(store.get(meeting.id)).toMatchObject({ state: "failed", error: "model" });
  });

  it("says why it cannot record, and leaves nothing behind when the recorder refuses", async () => {
    await expect(service(() => "macos").start()).rejects.toThrow("macos");
    process.env.FAKE_RECORDER_MODE = "no-permission";
    await expect(service().start()).rejects.toThrow("microphone");
    expect(store.list()).toEqual([]);
  });

  it("finishes a meeting Vunemi quit during, from its files", async () => {
    const m = store.create();
    m.lines.push({ source: "me", start: 0, end: 1, text: "yarım kalmış" });
    store.save(m);
    writeFileSync(join(store.folder(m.id), "mic.pcm"), speech(1));
    await service().recover("lmstudio:m");
    const done = store.get(m.id)!;
    expect(done.state).toBe("done");
    expect(done.lines.map((l) => l.text)).toEqual(["Bütçeyi konuştuk."]);
    expect(done.endedAt).not.toBeNull();
  });

  it("ends a silent meeting without asking the model", async () => {
    modelAnswer = () => {
      throw new Error("should not be asked");
    };
    const s = service();
    const meeting = await s.start();
    await s.stop("lmstudio:m");
    expect(store.get(meeting.id)).toMatchObject({ state: "done", summary: null });
  });

  it("keeps audio when transcription fails and retries it", async () => {
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "mic.pcm"), speech(1));
    transcriptionFails = true;
    await s.stop("lmstudio:m");
    expect(store.get(meeting.id)).toMatchObject({ state: "failed", error: "transcription" });
    expect(existsSync(join(store.folder(meeting.id), "mic.pcm"))).toBe(true);
    await s.retry(meeting.id, "lmstudio:m");
    expect(store.get(meeting.id)).toMatchObject({ state: "failed", error: "transcription" });
    transcriptionFails = false;
    await s.retry(meeting.id, "lmstudio:m");
    expect(store.get(meeting.id)).toMatchObject({ state: "done" });
    expect(existsSync(join(store.folder(meeting.id), "mic.pcm"))).toBe(false);
  });

  it("says whether it records without asking why it could not", async () => {
    let asked = 0;
    const s = service(() => {
      asked++;
      return null;
    });
    expect(s.isRecording).toBe(false);
    const meeting = await s.start();
    const before = asked;
    expect(s.isRecording).toBe(true);
    expect(asked).toBe(before);
    writeFileSync(join(store.folder(meeting.id), "system.pcm"), speech(1.5));
    await s.stop("lmstudio:m");
    expect(s.isRecording).toBe(false);
  });

  it("says it is summarising while the summary is written, and only then", async () => {
    const s = service();
    const during: boolean[] = [];
    modelAnswer = () => {
      during.push(s.summarising);
      return SUMMARY;
    };
    const meeting = await s.start();
    expect(s.summarising).toBe(false);
    writeFileSync(join(store.folder(meeting.id), "system.pcm"), speech(1.5));
    await s.stop("lmstudio:m");
    expect(during).toContain(true);
    expect(s.summarising).toBe(false);
  });
});

describe("telling the others apart", () => {
  /** A finished meeting with three lines of the others' and one of the user's. */
  function told(): string {
    const meeting = store.create();
    Object.assign(meeting, {
      state: "done",
      endedAt: 1,
      language: "tr",
      summary: "## Özet\n\nKişi 1 bütçeyi anlattı, Kişi 2 itiraz etti. Kişi 12 yoktu.",
      speakers: [{ id: 1, name: "" }, { id: 2, name: "" }],
      lines: [
        { source: "others", start: 0, end: 4, text: "Bütçe şöyle.", speaker: 1 },
        { source: "me", start: 5, end: 6, text: "Anladım." },
        { source: "others", start: 7, end: 9, text: "Katılmıyorum.", speaker: 2 },
        { source: "others", start: 10, end: 12, text: "Neden?", speaker: 1 },
      ],
    });
    store.save(meeting);
    return meeting.id;
  }

  it("gives each of the others' lines its speaker before the summary, which is told of them", async () => {
    turns = async () => [{ start: 0, end: 1.5, voice: 4 }];
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "system.pcm"), speech(1.5));
    await s.stop("lmstudio:m");
    const done = store.get(meeting.id)!;
    expect(done.state).toBe("done");
    expect(done.speakers).toEqual([{ id: 1, name: "" }]);
    expect(done.lines).toEqual([expect.objectContaining({ source: "others", speaker: 1 })]);
    expect(asked).toContain("Kişi 1: Bütçeyi konuştuk.");
    expect(asked).toContain("told apart by their voices");
  });

  it("leaves the others as one when it fails, and the meeting is still summarised", async () => {
    turns = async () => {
      throw new Error("no program");
    };
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "system.pcm"), speech(1.5));
    await s.stop("lmstudio:m");
    const done = store.get(meeting.id)!;
    expect(done.state).toBe("done");
    expect(done.speakers).toBeUndefined();
    expect(done.lines[0]!.speaker).toBeUndefined();
    expect(asked).toContain("Diğerleri: Bütçeyi konuştuk.");
    expect(asked).not.toContain("told apart by their voices");
  });

  it("is not asked when only the user spoke", async () => {
    let called = 0;
    turns = async () => (called++, []);
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "mic.pcm"), speech(1));
    await s.stop("lmstudio:m");
    expect(called).toBe(0);
    expect(store.get(meeting.id)!.speakers).toBeUndefined();
  });

  it("names a speaker, and the summary follows without touching a number that only starts the same", () => {
    const s = service();
    const id = told();
    s.nameSpeaker(id, 1, "  Deniz   Kaya ");
    expect(store.get(id)!.speakers).toEqual([{ id: 1, name: "Deniz Kaya" }, { id: 2, name: "" }]);
    expect(store.get(id)!.summary).toBe("## Özet\n\nDeniz Kaya bütçeyi anlattı, Kişi 2 itiraz etti. Kişi 12 yoktu.");
    // A second name takes the first one's place in the summary too, and an empty one gives the number back.
    s.nameSpeaker(id, 1, "Deniz");
    expect(store.get(id)!.summary).toContain("Deniz bütçeyi anlattı");
    s.nameSpeaker(id, 1, " ");
    expect(store.get(id)!.summary).toContain("Kişi 1 bütçeyi anlattı");
    // The window has no way to send an empty name: typing the number back does the same.
    s.nameSpeaker(id, 1, "Deniz");
    s.nameSpeaker(id, 1, "Kişi 1");
    expect(store.get(id)!.speakers![0]).toEqual({ id: 1, name: "" });
    expect(store.get(id)!.summary).toContain("Kişi 1 bütçeyi anlattı");
    s.nameSpeaker(id, 9, "Nobody");
    expect(store.get(id)!.speakers).toEqual([{ id: 1, name: "" }, { id: 2, name: "" }]);
  });

  it("merges two speakers that are one person", () => {
    const s = service();
    const id = told();
    s.nameSpeaker(id, 1, "Deniz");
    s.mergeSpeakers(id, 2, 1);
    const m = store.get(id)!;
    expect(m.speakers).toEqual([{ id: 1, name: "Deniz" }]);
    expect(m.lines.filter((l) => l.source === "others").map((l) => l.speaker)).toEqual([1, 1, 1]);
    expect(m.summary).toBe("## Özet\n\nDeniz bütçeyi anlattı, Deniz itiraz etti. Kişi 12 yoktu.");
    s.mergeSpeakers(id, 1, 1);
    s.mergeSpeakers(id, 1, 2);
    expect(store.get(id)!.speakers).toEqual([{ id: 1, name: "Deniz" }]);
  });

  it("gives one line to another speaker, and a speaker left with no line is gone", () => {
    const s = service();
    const id = told();
    // Not the user's own line, and not to someone who is not there.
    s.moveLine(id, 5, 1);
    s.moveLine(id, 0, 3);
    expect(store.get(id)!.lines.map((l) => l.speaker)).toEqual([1, undefined, 2, 1]);
    s.moveLine(id, 7, 1);
    const m = store.get(id)!;
    expect(m.lines.map((l) => l.speaker)).toEqual([1, undefined, 1, 1]);
    expect(m.speakers).toEqual([{ id: 1, name: "" }]);
  });

  it("changes nothing in a meeting whose others were never told apart", () => {
    const s = service();
    const meeting = store.create();
    Object.assign(meeting, { state: "done", lines: [{ source: "others", start: 0, end: 1, text: "a" }] });
    store.save(meeting);
    s.nameSpeaker(meeting.id, 1, "Deniz");
    expect(store.get(meeting.id)!.speakers).toBeUndefined();
  });
});

describe("renaming a meeting", () => {
  it("keeps a name given while recording through the summary", async () => {
    const s = service();
    const meeting = await s.start();
    writeFileSync(join(store.folder(meeting.id), "mic.pcm"), speech(1));
    s.rename(meeting.id, "  Haftalık   plan ");
    await s.stop("lmstudio:m");
    expect(store.get(meeting.id)).toMatchObject({ state: "done", title: "Haftalık plan" });
    s.rename(meeting.id, "Plan 2");
    expect(store.get(meeting.id)?.title).toBe("Plan 2");
  });
});
