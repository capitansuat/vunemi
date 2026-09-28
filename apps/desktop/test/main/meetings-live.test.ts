/**
 * Live transcription with a stand-in for whisper: the test writes PCM the way
 * the recorder does and checks which lines come out, when, and in what language.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Locale } from "@vunemi/i18n";
import { LiveTranscript, type Line } from "../../src/main/meetings/live.js";
import { RATE } from "../../src/main/meetings/segmenter.js";

const pcm = (seconds: number, amplitude: number) => {
  const out = Buffer.alloc(Math.round(seconds * RATE) * 2);
  for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return out;
};
const speech = (seconds: number) => pcm(seconds, 0.3);
const silence = (seconds: number) => pcm(seconds, 0);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-live-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Seconds of audio in a WAV, from its data size. */
const seconds = (w: Buffer) => w.readUInt32LE(40) / 2 / RATE;

function make(answer: (w: Buffer, language: Locale | "auto") => { text: string; language?: Locale; noSpeech?: number }) {
  const lines: Line[] = [];
  const asked: (Locale | "auto")[] = [];
  const live = new LiveTranscript({
    dir,
    pollMs: 10,
    transcribe: async (w, language) => {
      asked.push(language);
      await new Promise((r) => setTimeout(r, 5));
      const a = answer(w, language);
      return { text: a.text, language: a.language ?? "tr", noSpeech: a.noSpeech ?? 0.01 };
    },
    onLine: (line) => lines.push(line),
  });
  return { live, lines, asked };
}

describe("LiveTranscript", () => {
  it("writes lines from both sources as they are recorded, and the rest on finish", async () => {
    writeFileSync(join(dir, "mic.pcm"), Buffer.concat([silence(1), speech(1), silence(1)]));
    const { live, lines } = make((w) => ({ text: `${seconds(w).toFixed(1)} s` }));
    live.start();
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "me", text: expect.stringMatching(/ s$/) });
    expect(lines[0]!.start).toBeCloseTo(0.85, 1);

    // The system file appears later, and ends mid-speech: finish closes it.
    writeFileSync(join(dir, "system.pcm"), Buffer.concat([silence(3.5), speech(1)]));
    appendFileSync(join(dir, "mic.pcm"), Buffer.concat([speech(0.5), silence(1)]).subarray(1)); // odd byte boundary
    await live.finish();
    expect(live.pending).toBe(0);
    expect(lines.map((l) => l.source)).toEqual(["me", "me", "others"]);
    expect(lines[2]!.start).toBeCloseTo(3.35, 1);
  });

  it("drops what whisper believes is silence, and subtitle credits", async () => {
    writeFileSync(join(dir, "mic.pcm"), Buffer.concat([speech(1), silence(1), speech(1), silence(1), speech(1), silence(1)]));
    let n = 0;
    const { live, lines } = make(() => [{ text: "Altyazı M.K." }, { text: "Bir şey", noSpeech: 0.9 }, { text: "Bütçe tamam." }][n++]!);
    live.start();
    await live.finish();
    expect(lines.map((l) => l.text)).toEqual(["Bütçe tamam."]);
  });

  it("fixes the language after a minute of speech", async () => {
    const stretch = Buffer.concat([speech(18), silence(1)]);
    writeFileSync(join(dir, "system.pcm"), Buffer.concat([stretch, stretch, stretch, stretch, stretch]));
    let n = 0;
    const { live, asked } = make(() => ({ text: `line ${n}`, language: n++ === 1 ? "en" : "tr" }));
    await live.finish();
    // 18 s stretches: sixty seconds are reached with the fourth.
    expect(asked).toEqual(["auto", "auto", "auto", "auto", "tr"]);
    expect(live.language).toBe("tr");
  });

  it("keeps going when one stretch fails", async () => {
    writeFileSync(join(dir, "mic.pcm"), Buffer.concat([speech(1), silence(1), speech(1), silence(1)]));
    let n = 0;
    const { live, lines } = make(() => {
      if (n++ === 0) throw new Error("whisper hiccup");
      return { text: "ikinci" };
    });
    await live.finish();
    expect(lines.map((l) => l.text)).toEqual(["ikinci"]);
  });
});
