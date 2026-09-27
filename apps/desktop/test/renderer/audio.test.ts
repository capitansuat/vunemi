/**
 * The WAV the microphone produces. whisper reads the header before it reads a
 * sample, so a wrong byte here is silence that looks like a model problem.
 */
import { describe, expect, it } from "vitest";
import { encodeWav, SAMPLE_RATE } from "../../src/renderer/src/lib/audio.js";

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
