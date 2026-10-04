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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vunemi-service-"));
  store = new MeetingStore(join(root, "meetings"), async (path) => rmSync(path, { recursive: true }));
  recorder = new Recorder(FAKE);
  statuses = [];
  modelAnswer = () => SUMMARY;
  transcriptionFails = false;
  delete process.env.FAKE_RECORDER_MODE;
});
afterEach(() => {
  recorder.dispose();
  rmSync(root, { recursive: true, force: true });
});

function service(blocked: () => "macos" | null = () => null) {
  const model: ChatModel = {
    id: "fake",
    chat: async () => {
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
    words: () => ({ names: { me: "Ben", others: "Diğerleri" }, headings: { summary: "Özet", decisions: "Kararlar", actions: "Yapılacaklar", questions: "Sorular" }, language: "Turkish" }),
    blocked,
    onChange: (s) => statuses.push(s),
    onLine: () => {},
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
