/**
 * Cutting meeting audio at silences, with made-up sound: a tone for speech,
 * zeros or faint noise for silence.
 */
import { describe, expect, it } from "vitest";
import { silencePhrase } from "../../src/main/meetings/filter.js";
import { RATE, Segmenter, wav, type Segment } from "../../src/main/meetings/segmenter.js";

const tone = (seconds: number, amplitude = 0.3) =>
  Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE)));
const quiet = (seconds: number) => new Int16Array(Math.round(seconds * RATE));
const join = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const times = (segments: Segment[]) => segments.map((s) => [Number(s.start.toFixed(2)), Number(s.end.toFixed(2))]);

function cut(audio: Int16Array, chunk = audio.length): Segment[] {
  const s = new Segmenter();
  const out: Segment[] = [];
  for (let i = 0; i < audio.length; i += chunk) out.push(...s.push(audio.subarray(i, i + chunk)));
  return [...out, ...s.flush()];
}

describe("Segmenter", () => {
  it("splits two stretches of speech at a second of silence", () => {
    const segments = cut(join(quiet(1), tone(1), quiet(1), tone(2), quiet(1)));
    expect(segments).toHaveLength(2);
    // Each starts a little early (the pre-roll) and ends after the silence that closed it.
    const [a, b] = times(segments);
    expect(a![0]).toBeCloseTo(0.85, 1);
    expect(a![1]).toBeCloseTo(2.6, 1);
    expect(b![0]).toBeCloseTo(2.85, 1);
    expect(b![1]).toBeCloseTo(5.6, 1);
    expect(segments[0]!.samples.length).toBe(Math.round((segments[0]!.end - segments[0]!.start) * RATE));
  });

  it("cuts long speech at 20 seconds", () => {
    const segments = cut(tone(25));
    expect(segments).toHaveLength(2);
    expect(segments[0]!.end - segments[0]!.start).toBeCloseTo(20, 1);
    expect(segments[1]!.end).toBeCloseTo(25, 1);
  });

  it("sends nothing for noise under the floor or a click", () => {
    expect(cut(tone(5, 0.005))).toEqual([]);
    expect(cut(join(quiet(1), tone(0.1), quiet(1)))).toEqual([]);
  });

  it("cuts the same wherever the chunks break", () => {
    const audio = join(quiet(0.5), tone(1.3), quiet(0.9), tone(0.7), quiet(0.2));
    const whole = times(cut(audio));
    for (const chunk of [1, 77, 480, 1601, 16_000]) expect(times(cut(audio, chunk))).toEqual(whole);
  });
});

describe("wav", () => {
  it("writes a 44-byte header with the right sizes", () => {
    const out = wav(Int16Array.from([1, -1, 2]));
    expect(out.length).toBe(50);
    expect(out.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.readUInt32LE(4)).toBe(42);
    expect(out.readUInt32LE(24)).toBe(16_000);
    expect(out.readUInt32LE(40)).toBe(6);
    expect(out.readInt16LE(46)).toBe(-1);
  });
});

describe("silencePhrase", () => {
  it("catches what whisper writes over silence", () => {
    for (const text of ["Altyazı M.K.", "Thank you for watching!", "[Music]", "(müzik)", "", " ... ", "Subtitles by the Amara.org community", "ご視聴ありがとうございました"]) {
      expect(silencePhrase(text), text).toBe(true);
    }
  });

  it("keeps what people say", () => {
    for (const text of ["Bütçeyi cuma gününe kadar bitirelim.", "Thank you, that was helpful.", "OK", "3"]) {
      expect(silencePhrase(text), text).toBe(false);
    }
  });
});
