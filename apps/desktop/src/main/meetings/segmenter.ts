/**
 * Cuts a stream of 16 kHz mono PCM into the stretches someone spoke in, so
 * each can be written down on its own while the meeting goes on.
 *
 * Loudness alone decides, 30 ms at a time: a stretch starts at a frame above
 * the floor and ends after 0.6 s below it, or at 20 s however much is still
 * being said. A stretch with under 300 ms of sound in it is a cough or a
 * click, and whisper, given one, tends to invent a sentence; it is dropped.
 */

export const RATE = 16_000;

export interface Segment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  samples: Int16Array;
}

export interface SegmenterOptions {
  silenceMs?: number;
  maxMs?: number;
  /** Frame RMS, as a fraction of full scale, above which a frame is sound. */
  floor?: number;
  frameMs?: number;
  minVoicedMs?: number;
}

/** A little of what came just before, so a quiet first syllable is not cut off. */
const PRE_ROLL_FRAMES = 5;

export class Segmenter {
  private readonly frame: number;
  private readonly silenceFrames: number;
  private readonly maxSamples: number;
  private readonly floor: number;
  private readonly minVoicedFrames: number;

  private carry = new Int16Array(0);
  /** Samples consumed so far, always a whole number of frames. */
  private position = 0;
  private preRoll: Int16Array[] = [];
  private open: { start: number; frames: Int16Array[]; length: number; voiced: number; silent: number } | null = null;

  constructor(opts: SegmenterOptions = {}) {
    const frameMs = opts.frameMs ?? 30;
    this.frame = Math.round((RATE * frameMs) / 1000);
    this.silenceFrames = Math.ceil((opts.silenceMs ?? 600) / frameMs);
    this.maxSamples = Math.round((RATE * (opts.maxMs ?? 20_000)) / 1000);
    this.floor = (opts.floor ?? 0.012) * 32768;
    this.minVoicedFrames = Math.ceil((opts.minVoicedMs ?? 300) / frameMs);
  }

  /** Seconds up to which every stretch is closed: nothing later can start before this. */
  get settled(): number {
    return (this.open ? this.open.start : this.position) / RATE;
  }

  /** Seconds of audio read so far. */
  get heard(): number {
    return this.position / RATE;
  }

  /** Feeds samples in; returns the stretches that ended. */
  push(chunk: Int16Array): Segment[] {
    const all = new Int16Array(this.carry.length + chunk.length);
    all.set(this.carry);
    all.set(chunk, this.carry.length);
    const done: Segment[] = [];
    let offset = 0;
    for (; offset + this.frame <= all.length; offset += this.frame) {
      const segment = this.step(all.slice(offset, offset + this.frame));
      if (segment) done.push(segment);
    }
    this.carry = all.slice(offset);
    return done;
  }

  /** At the end of the recording: whatever was still open. */
  flush(): Segment[] {
    const segment = this.close();
    this.carry = new Int16Array(0);
    return segment ? [segment] : [];
  }

  private step(frame: Int16Array): Segment | null {
    const frameStart = this.position;
    this.position += frame.length;
    let sum = 0;
    for (const s of frame) sum += s * s;
    const voiced = Math.sqrt(sum / frame.length) > this.floor;

    if (!this.open) {
      if (!voiced) {
        this.preRoll.push(frame);
        if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
        return null;
      }
      const before = this.preRoll;
      const length = before.reduce((n, f) => n + f.length, 0);
      this.open = { start: frameStart - length, frames: [...before], length, voiced: 0, silent: 0 };
      this.preRoll = [];
    }

    const open = this.open;
    open.frames.push(frame);
    open.length += frame.length;
    if (voiced) {
      open.voiced++;
      open.silent = 0;
    } else {
      open.silent++;
    }
    if (open.silent >= this.silenceFrames || open.length >= this.maxSamples) return this.close();
    return null;
  }

  private close(): Segment | null {
    const open = this.open;
    this.open = null;
    if (!open || open.voiced < this.minVoicedFrames) return null;
    const samples = new Int16Array(open.length);
    let at = 0;
    for (const f of open.frames) {
      samples.set(f, at);
      at += f.length;
    }
    return { start: open.start / RATE, end: (open.start + open.length) / RATE, samples };
  }
}

/** Samples as a WAV file whisper can read. */
export function wav(samples: Int16Array, rate = RATE): Buffer {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}
