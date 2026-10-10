/**
 * The microphone end of voice. Only the renderer can reach a capture device,
 * so this records and hands finished 16 kHz mono WAV bytes to the main
 * process; nothing is uploaded and nothing is kept after the clip is read.
 *
 * Also the earcons: short generated tones, because the four voice states have
 * to be distinguishable without looking at the screen.
 */

/** whisper wants 16 kHz mono; asking for it here avoids resampling later. */
export const SAMPLE_RATE = 16_000;

/** No frame quieter than this is ever speech, whatever the room sounds like. */
const FLOOR = 0.015;
/**
 * The same, while voice chat listens by itself: only a voice near the
 * microphone is a turn. With the microphone open for as long as the chat is,
 * people talking across the room were heard as questions and answered; they
 * came in between 0.02 and 0.035, a voice at the Mac several times that.
 */
const NEAR_FLOOR = 0.04;
/** Speech has to stand this far above the room's own noise to count. */
const OVER_NOISE = 3.5;
/** How long the room has to stay quiet before a hands-free turn ends, after a few words… */
const SILENCE_MS = 1_300;
/**
 * …and this much longer for every second they have been talking, up to the
 * most: someone explaining something stops to think, and a turn that ended
 * at the first such stop could not be finished.
 */
const SILENCE_MORE_MS = 200;
const SILENCE_MOST_MS = 3_000;
/** Don't end a turn on the pause before someone starts talking. */
const MIN_SPEECH_MS = 400;
/** Speaking over Vunemi: this long without a break is someone talking, not a cough or a cup put down. */
const OVER_MS = 600;
/** A gap this long ends one stretch of talking. */
const BREAK_MS = 200;
/** Room kept on either side of what was said: a breath in, a last consonant. */
const EDGE_MS = 300;
/** Kept from before someone was known to be talking: their first word. */
const LEAD_IN_MS = 600;
/** The room is never taken to be louder than this many times the quietest moment heard. */
const ROOM_OVER_QUIETEST = 2;
/** The room is as loud as the quietest tenth of the clip. */
const ROOM_PERCENTILE = 0.1;
/** The first moments of a stream can be digital silence; they say nothing about the room. */
const WARM_UP_MS = 100;
/** Loudness buckets, on a log scale from 1e-5 to 1, for the room estimate. */
const BUCKETS = 100;

/**
 * Tells speech from the room it is spoken in. While listening, the room's
 * noise is the level of the quietest tenth of the clip so far: the pauses
 * between words, the moment before speaking. It used to be learnt from the first 0.4 s only, so
 * someone who started talking the moment they pressed the mic taught it
 * that their voice was the room, and nothing they said stood out from it:
 * "Nothing was heard".
 */
export class SpeechGate {
  private readonly counts = new Array<number>(BUCKETS).fill(0);
  private counted = 0;
  private elapsedMs = 0;
  private smooth = -1;
  private quietest = Infinity;
  private readonly heard: { level: number; ms: number }[] = [];
  private speechMs = 0;
  private quietMs = 0;
  /** The stretch of talking under way, and the break in it. */
  private runMs = 0;
  private gapMs = 0;
  private ended = false;

  /** `floor`: the level under which nothing is speech. */
  constructor(private readonly floor = FLOOR) {}

  /** One frame's loudness (RMS) and length. True once a hands-free turn has ended in silence. */
  feed(level: number, ms: number): boolean {
    // A little smoothing, so one quiet sample between syllables isn't taken for the room.
    this.smooth = this.smooth < 0 ? level : this.smooth * 0.6 + level * 0.4;
    this.heard.push({ level: this.smooth, ms });
    this.elapsedMs += ms;
    if (this.elapsedMs > WARM_UP_MS) {
      this.counts[bucket(this.smooth)]! += 1;
      this.counted += 1;
      this.quietest = Math.min(this.quietest, this.smooth);
    }

    if (this.counted > 0 && this.smooth > this.threshold()) {
      this.speechMs += ms;
      this.quietMs = 0;
      this.runMs += ms;
      this.gapMs = 0;
    } else {
      this.gapMs += ms;
      if (this.gapMs >= BREAK_MS) this.runMs = 0;
      if (this.speechMs > MIN_SPEECH_MS) {
        this.quietMs += ms;
        if (this.quietMs >= this.patience()) this.ended = true;
      }
    }
    return this.ended;
  }

  /** How long a silence ends the turn, for what has been said so far. */
  private patience(): number {
    return Math.min(SILENCE_MOST_MS, SILENCE_MS + (Math.max(0, this.speechMs - 1_000) / 1_000) * SILENCE_MORE_MS);
  }

  /** Someone is talking right now, and has been for long enough to mean it. */
  talking(): boolean {
    return this.runMs >= OVER_MS;
  }

  /**
   * Whether the clip held a sentence: long enough, and loud enough, against
   * the quietest moment in it — judged over the whole clip at the end, so
   * words said before the room was known count too, and one breath between
   * sentences is enough to know it.
   */
  spoke(): boolean {
    const threshold = Math.max(this.floor, (Number.isFinite(this.quietest) ? this.quietest : 0) * OVER_NOISE);
    let speech = 0;
    let loudest = 0;
    for (const f of this.heard) {
      if (f.level > threshold) speech += f.ms;
      loudest = Math.max(loudest, f.level);
    }
    return speech >= MIN_SPEECH_MS && loudest >= threshold * 1.5;
  }

  /**
   * The first and the last frame with a voice in it, by their place among
   * the frames fed; null when there was none. What lies outside is the room.
   */
  span(): [number, number] | null {
    const threshold = Math.max(this.floor, (Number.isFinite(this.quietest) ? this.quietest : 0) * OVER_NOISE);
    let first = -1;
    let last = -1;
    this.heard.forEach((f, i) => {
      if (f.level <= threshold) return;
      if (first < 0) first = i;
      last = i;
    });
    return first < 0 ? null : [first, last];
  }

  private threshold(): number {
    return Math.max(this.floor, this.room() * OVER_NOISE);
  }

  private room(): number {
    const want = Math.max(1, Math.ceil(this.counted * ROOM_PERCENTILE));
    let seen = 0;
    let tenth = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i]!;
      if (seen >= want) {
        tenth = 10 ** (-5 + ((i + 1) * 5) / BUCKETS);
        break;
      }
    }
    // Someone who talks on without a break makes their own voice the quietest
    // tenth, and was then heard as silence in the middle of a sentence. The
    // quietest moment of all is still the room: it holds the estimate down.
    return Math.min(tenth, this.quietest * ROOM_OVER_QUIETEST);
  }
}

function bucket(level: number): number {
  const at = Math.floor(((Math.log10(Math.max(level, 1e-5)) + 5) / 5) * BUCKETS);
  return Math.min(BUCKETS - 1, Math.max(0, at));
}

/** Served from the renderer's own origin; see public/capture-worklet.js. */
const WORKLET_URL = "capture-worklet.js";

export interface Recorder {
  /** Everything heard so far, for a running transcript. Null until someone speaks. */
  snapshot(): ArrayBuffer | null;
  /** Ends the turn and returns the clip, or null if nothing was said. */
  stop(): Promise<ArrayBuffer | null>;
  /** Throws the audio away and releases the microphone. */
  cancel(): void;
  /** Vunemi has stopped talking: from here on it is the user's turn that is recorded. */
  engage(): void;
  /** Whether anyone has spoken in this turn so far. */
  spoke(): boolean;
}

/** A frame arrives every ~8 ms; the eye needs far fewer than that. */
const LEVEL_EVERY_MS = 55;

export interface RecorderOptions {
  /** 0–1, for the waveform. Throttled to something a UI can redraw. */
  onLevel(level: number): void;
  /** Hands-free mode: the speaker stopped, so end the turn. */
  onSilence?: () => void;
  /**
   * Opens the microphone while Vunemi is talking. Nothing is recorded until
   * the user speaks over it (told here once, with their first words kept)
   * or until engage() hands them the turn.
   */
  onSpokenOver?: () => void;
  /** Only a voice near the microphone counts: voice chat listening by itself. */
  near?: boolean;
}

/**
 * Opens the microphone. Rejects if the user (or macOS) refuses, so callers
 * should be ready to fall back to the keyboard.
 */
export async function record(opts: RecorderOptions): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // No automatic gain: it lifts an empty room up to speech level, and then
    // silence looks exactly like talking.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });

  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    await context.close();
    for (const track of stream.getTracks()) track.stop();
    throw err;
  }

  let chunks: Float32Array[] = [];
  let frames = 0;
  let done = false;
  let lastLevelAt = 0;
  let peak = 0;
  const floor = opts.near ? NEAR_FLOOR : FLOOR;
  let gate = new SpeechGate(floor);
  // While Vunemi talks, the microphone is only watched for a voice over it.
  let waiting = opts.onSpokenOver !== undefined;
  const leadIn = Math.round((LEAD_IN_MS / 1000) * SAMPLE_RATE);

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "vunemi-capture");
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (done) return;
    const frame = e.data;
    chunks.push(frame);
    frames += frame.length;

    const level = rms(frame);
    if (waiting) {
      gate.feed(level, (frame.length / SAMPLE_RATE) * 1000);
      if (gate.talking()) {
        // Theirs from the first word: the turn starts with what was just heard.
        waiting = false;
        const kept = chunks;
        chunks = [];
        frames = 0;
        gate = new SpeechGate(floor);
        for (const f of kept) {
          chunks.push(f);
          frames += f.length;
          gate.feed(rms(f), (f.length / SAMPLE_RATE) * 1000);
        }
        opts.onSpokenOver?.();
      } else {
        while (chunks.length > 1 && frames - chunks[0]!.length >= leadIn) frames -= chunks.shift()!.length;
      }
      return;
    }
    // Report the loudest frame in the window, so a short syllable still shows.
    peak = Math.max(peak, Math.min(level * 6, 1));
    const now = performance.now();
    if (now - lastLevelAt >= LEVEL_EVERY_MS) {
      lastLevelAt = now;
      opts.onLevel(peak);
      peak = 0;
    }

    if (gate.feed(level, (frame.length / SAMPLE_RATE) * 1000)) {
      done = true;
      opts.onSilence?.();
    }
  };
  source.connect(node);
  // A worklet with no destination is still pulled, but connecting through a
  // silent gain keeps the graph running on every Chromium version.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  /** Long enough, and loud enough against this room, to be a sentence. */
  const spoke = (): boolean => gate.spoke();

  /**
   * What was said, without the room before and after it. In voice chat the
   * microphone is open for seconds before anyone speaks, and whisper writes
   * words for a silence that long: a turn came back with a made-up sentence
   * in front of the real one.
   */
  const said = (): Float32Array => {
    const span = gate.span();
    if (!span) return merge(chunks, frames);
    const margin = Math.round((EDGE_MS / 1000) * SAMPLE_RATE);
    let from = span[0];
    for (let kept = 0; from > 0 && kept < margin; from--) kept += chunks[from - 1]!.length;
    let to = span[1];
    for (let kept = 0; to < chunks.length - 1 && kept < margin; to++) kept += chunks[to + 1]!.length;
    const part = chunks.slice(from, to + 1);
    return merge(part, part.reduce((sum, c) => sum + c.length, 0));
  };

  const release = () => {
    done = true;
    node.port.onmessage = null;
    node.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };

  return {
    snapshot() {
      if (!spoke() || frames < SAMPLE_RATE / 2) return null;
      return encodeWav(said());
    },

    async stop() {
      release();
      // Under a quarter second is a slip of the finger, not a sentence.
      if (frames < SAMPLE_RATE / 4) return null;
      // And a clip with no speech in it is worse than nothing: whisper fills
      // silence with whatever its training data was full of ("İzlediğiniz
      // için teşekkürler"). If nobody spoke, nobody spoke.
      if (!spoke()) return null;
      return encodeWav(said());
    },
    cancel: release,
    engage() {
      if (!waiting) return;
      waiting = false;
      chunks = [];
      frames = 0;
      gate = new SpeechGate(floor);
    },
    spoke,
  };
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / frame.length);
}

function merge(chunks: Float32Array[], total: number): Float32Array {
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/** 16-bit PCM WAV — the one format every whisper build reads without help. */
export function encodeWav(samples: Float32Array, rate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// -- earcons ------------------------------------------------------------------

type Earcon = "start" | "stop" | "error";

/** Two notes each: up means the turn is yours, down means it's Vunemi's. */
const TONES: Record<Earcon, [number, number]> = {
  start: [660, 880],
  stop: [880, 660],
  error: [320, 240],
};

let tones: AudioContext | null = null;

export function earcon(kind: Earcon): void {
  try {
    tones ??= new AudioContext();
    const ctx = tones;
    void ctx.resume();
    TONES[kind].forEach((hz, i) => {
      const at = ctx.currentTime + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      // A short envelope: a click is worse than no sound at all.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.09);
    });
  } catch {
    // No audio output; the visible state is the real signal anyway.
  }
}
