/**
 * The WAV the microphone produces. whisper reads the header before it reads a
 * sample, so a wrong byte here is silence that looks like a model problem.
 */
import { describe, expect, it } from "vitest";
import { encodeWav, SAMPLE_RATE, SpeechGate } from "../../src/renderer/src/lib/audio.js";

const text = (view: DataView, at: number, length: number): string =>
  String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(at + i)));

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header at the rate whisper wants", () => {
    const wav = encodeWav(new Float32Array(160));
    const view = new DataView(wav);

    expect(text(view, 0, 4)).toBe("RIFF");
    expect(text(view, 8, 8)).toBe("WAVEfmt ");
    expect(text(view, 36, 4)).toBe("data");
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1); // PCM, uncompressed
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(SAMPLE_RATE * 2); // bytes per second
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(320); // 160 samples, two bytes each
    expect(wav.byteLength).toBe(44 + 320);
  });

  it("maps the float range onto the full 16-bit range", () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5])));
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(16383);
  });

  it("clips instead of wrapping around, so a loud voice doesn't turn to noise", () => {
    const view = new DataView(encodeWav(new Float32Array([4, -4])));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("can be told another rate", () => {
    const view = new DataView(encodeWav(new Float32Array(8), 48_000));
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(96_000);
  });
});

describe("SpeechGate", () => {
  const FRAME_MS = 8;
  const feed = (gate: SpeechGate, level: number, ms: number) => {
    let ended = false;
    for (let t = 0; t < ms; t += FRAME_MS) ended = gate.feed(level, FRAME_MS) || ended;
    return ended;
  };
  const ROOM = 0.004;
  const VOICE = 0.08;

  it("hears someone who starts talking the moment the mic opens", () => {
    const gate = new SpeechGate();
    feed(gate, VOICE, 900); // "Hello, please…" straight away
    feed(gate, ROOM, 150); // a breath
    feed(gate, VOICE, 700);
    expect(gate.spoke()).toBe(true);
  });

  it("hears someone who waits a moment first", () => {
    const gate = new SpeechGate();
    feed(gate, ROOM, 600);
    feed(gate, VOICE, 800);
    expect(gate.spoke()).toBe(true);
  });

  it("hears nothing in a quiet room, or in a steady noisy one", () => {
    const quiet = new SpeechGate();
    feed(quiet, ROOM, 3_000);
    expect(quiet.spoke()).toBe(false);
    const fan = new SpeechGate();
    feed(fan, 0.03, 3_000);
    expect(fan.spoke()).toBe(false);
  });

  it("doesn't count a cough", () => {
    const gate = new SpeechGate();
    feed(gate, ROOM, 500);
    feed(gate, VOICE, 150);
    feed(gate, ROOM, 500);
    expect(gate.spoke()).toBe(false);
  });

  it("knows someone is talking over it once they have kept at it, and not from a cough", () => {
    const gate = new SpeechGate();
    feed(gate, ROOM, 2_000);
    feed(gate, VOICE, 150);
    expect(gate.talking()).toBe(false);
    feed(gate, ROOM, 400);
    feed(gate, VOICE, 400);
    // Two short sounds with a silence between them are not one stretch of talking.
    expect(gate.talking()).toBe(false);
    feed(gate, VOICE, 250);
    expect(gate.talking()).toBe(true);
    // A syllable's gap does not end it; a pause does.
    feed(gate, ROOM, 100);
    expect(gate.talking()).toBe(true);
    feed(gate, ROOM, 300);
    expect(gate.talking()).toBe(false);
  });

  it("ends a hands-free turn once the speaker has been quiet a while", () => {
    const gate = new SpeechGate();
    expect(feed(gate, VOICE, 1_000)).toBe(false);
    expect(feed(gate, ROOM, 300)).toBe(false);
    expect(feed(gate, VOICE, 600)).toBe(false);
    expect(feed(gate, ROOM, 1_300)).toBe(false);
    expect(feed(gate, ROOM, 300)).toBe(true);
  });

  it("knows where the voice begins and ends, so the room around it can be left out", () => {
    const gate = new SpeechGate();
    expect(gate.span()).toBeNull();
    feed(gate, ROOM, 4_000); // the microphone was open before anyone spoke
    feed(gate, VOICE, 1_000);
    feed(gate, ROOM, 200);
    feed(gate, VOICE, 500);
    feed(gate, ROOM, 2_000);
    const [first, last] = gate.span()!;
    // Within a few frames of the edges: the level is smoothed.
    expect(Math.abs(first * FRAME_MS - 4_000)).toBeLessThan(50);
    expect(Math.abs(last * FRAME_MS - 5_700)).toBeLessThan(80);
    const quiet = new SpeechGate();
    feed(quiet, ROOM, 3_000);
    expect(quiet.span()).toBeNull();
  });

  it("keeps hearing someone who talks on without a break", () => {
    // Live, 10 Oct: a long turn was cut in the middle. The voice had become the
    // quietest tenth of the clip, and so the room it was measured against.
    const gate = new SpeechGate();
    feed(gate, ROOM, 300);
    expect(feed(gate, VOICE, 30_000)).toBe(false);
    expect(feed(gate, VOICE * 0.4, 5_000)).toBe(false);
    expect(gate.spoke()).toBe(true);
    expect(feed(gate, ROOM, 3_100)).toBe(true);
  });

  it("waits longer for someone who has been talking for a while: they stop to think", () => {
    const gate = new SpeechGate();
    feed(gate, ROOM, 300);
    expect(feed(gate, VOICE, 10_000)).toBe(false);
    // A pause that would have ended a short turn.
    expect(feed(gate, ROOM, 2_000)).toBe(false);
    expect(feed(gate, VOICE, 3_000)).toBe(false);
    expect(feed(gate, ROOM, 2_900)).toBe(false);
    expect(feed(gate, ROOM, 200)).toBe(true);
  });
});
