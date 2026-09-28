/**
 * Live transcription with a stand-in for whisper: the test writes PCM the way
 * the recorder does and checks which lines come out, when, and in what language.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Locale } from "@vunemi/i18n";
import { echoes, LiveTranscript, type Line } from "../../src/main/meetings/live.js";
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
    // The recorder writes the system's silence as it goes; "Me" waits for it.
    writeFileSync(join(dir, "system.pcm"), silence(5));
    let n = 0;
    const { live, lines } = make(() => ({ text: ["Birinci cümle.", "İkinci konu.", "Üçüncü başlık."][n++]! }));
    live.start();
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "me", text: "Birinci cümle." });
    expect(lines[0]!.start).toBeCloseTo(0.85, 1);

    // The system audio goes on, and ends mid-speech: finish closes it.
    appendFileSync(join(dir, "system.pcm"), speech(1));
    appendFileSync(join(dir, "mic.pcm"), Buffer.concat([speech(0.5), silence(1)]).subarray(1)); // odd byte boundary
    await live.finish();
    expect(live.pending).toBe(0);
    // A "Me" line may come after an "others" one it overlaps; the meeting keeps them in time order.
    const inOrder = [...lines].sort((a, b) => a.start - b.start);
    expect(inOrder.map((l) => l.source)).toEqual(["me", "me", "others"]);
    expect(inOrder[2]!.start).toBeCloseTo(4.85, 1);
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

describe("echo from the speakers", () => {
  it("drops a line the microphone only heard from the speakers, and keeps the user's own", async () => {
    // The others say something at 1 s; the microphone hears it too. At 4 s the user speaks.
    writeFileSync(join(dir, "system.pcm"), Buffer.concat([silence(1), speech(1), silence(4)]));
    writeFileSync(join(dir, "mic.pcm"), Buffer.concat([silence(1), speech(1), silence(2), speech(1.5), silence(1)]));
    const { live, lines } = make((w) => ({ text: seconds(w) < 2 ? "Bütçeyi cuma günü bitirelim." : "Bence perşembe daha iyi." }));
    live.start();
    await live.finish();
    expect(lines.map((l) => `${l.source}: ${l.text}`)).toEqual(["others: Bütçeyi cuma günü bitirelim.", "me: Bence perşembe daha iyi."]);
  });

  it("tells an echo by the words it shares", () => {
    expect(echoes("bütçeyi cuma bitirelim", "Bütçeyi cuma günü bitirelim.")).toBe(true);
    expect(echoes("Tamam, katılıyorum.", "Bütçeyi cuma günü bitirelim.")).toBe(false);
    expect(echoes("", "x")).toBe(false);
  });
});
