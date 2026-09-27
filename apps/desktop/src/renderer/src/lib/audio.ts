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
/** Speech has to stand this far above the room's own noise to count. */
const OVER_NOISE = 3.5;
/** The opening moments of a clip, used to learn what this room sounds like. */
const NOISE_SAMPLE_MS = 400;
/** How long the room has to stay quiet before a hands-free turn ends. */
const SILENCE_MS = 1_100;
/** Don't end a turn on the pause before someone starts talking. */
const MIN_SPEECH_MS = 400;

/** Served from the renderer's own origin; see public/capture-worklet.js. */
const WORKLET_URL = "capture-worklet.js";

export interface Recorder {
  /** Everything heard so far, for a running transcript. Null until someone speaks. */
  snapshot(): ArrayBuffer | null;
  /** Ends the turn and returns the clip, or null if nothing was said. */
  stop(): Promise<ArrayBuffer | null>;
  /** Throws the audio away and releases the microphone. */
  cancel(): void;
}

/** A frame arrives every ~8 ms; the eye needs far fewer than that. */
const LEVEL_EVERY_MS = 55;

export interface RecorderOptions {
  /** 0–1, for the waveform. Throttled to something a UI can redraw. */
  onLevel(level: number): void;
  /** Hands-free mode: the speaker stopped, so end the turn. */
  onSilence?: () => void;
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

  const chunks: Float32Array[] = [];
  let frames = 0;
  let speechMs = 0;
  let quietMs = 0;
  let done = false;
  let lastLevelAt = 0;
  let peak = 0;
  let loudest = 0;
  let noise = 0;
  let noiseMs = 0;

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "ocak-capture");
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (done) return;
    const frame = e.data;
    chunks.push(frame);
    frames += frame.length;

    const level = rms(frame);
    // Report the loudest frame in the window, so a short syllable still shows.
    peak = Math.max(peak, Math.min(level * 6, 1));
    const now = performance.now();
    if (now - lastLevelAt >= LEVEL_EVERY_MS) {
      lastLevelAt = now;
      opts.onLevel(peak);
      peak = 0;
    }

    const ms = (frame.length / SAMPLE_RATE) * 1000;
    loudest = Math.max(loudest, level);

    // Learn the room first, then judge against it.
    if (noiseMs < NOISE_SAMPLE_MS) {
      noise = noise === 0 ? level : noise * 0.8 + level * 0.2;
      noiseMs += ms;
      return;
    }
    const threshold = Math.max(FLOOR, noise * OVER_NOISE);

    if (level > threshold) {
      speechMs += ms;
      quietMs = 0;
    } else if (speechMs > MIN_SPEECH_MS) {
      quietMs += ms;
      if (quietMs >= SILENCE_MS) {
        done = true;
        opts.onSilence?.();
      }
    }
  };
  source.connect(node);
  // A worklet with no destination is still pulled, but connecting through a
  // silent gain keeps the graph running on every Chromium version.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  /** Long enough, and loud enough against this room, to be a sentence. */
  const spoke = (): boolean => speechMs >= MIN_SPEECH_MS && loudest >= Math.max(FLOOR, noise * OVER_NOISE) * 1.5;

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
      return encodeWav(merge(chunks, frames));
    },

    async stop() {
      release();
      // Under a quarter second is a slip of the finger, not a sentence.
      if (frames < SAMPLE_RATE / 4) return null;
      // And a clip with no speech in it is worse than nothing: whisper fills
      // silence with whatever its training data was full of ("İzlediğiniz
      // için teşekkürler"). If nobody spoke, nobody spoke.
      if (!spoke()) return null;
      return encodeWav(merge(chunks, frames));
    },
    cancel: release,
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
