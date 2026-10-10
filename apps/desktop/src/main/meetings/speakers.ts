/**
 * Telling the others in a meeting apart, once it is over.
 *
 * The recorder keeps two files: the microphone is "Me", and everyone heard
 * through the computer is in the other. When the user has switched this on,
 * that second file is read by sherpa-onnx (Apache-2.0) with two small
 * models: pyannote's segmentation 3.0 (MIT) finds who speaks when, and
 * 3D-Speaker's CAM++ (Apache-2.0) tells the voices apart. Each line of the
 * transcript then belongs to "Person 1", "Person 2"…, which the user can
 * name, merge and correct.
 *
 * It tells voices apart; it does not know who anyone is, and it keeps no
 * voice print: nothing of a voice outlasts the meeting's audio.
 *
 * It makes mistakes. Measured on synthetic recordings (10 Oct): four clearly
 * different voices in long turns came out 98% right by time; six voices with
 * two alike, one-word turns and telephone sound 62 to 74%, the one-word
 * turns mostly wrong. So the labels are a first guess, and everything about
 * them can be put right by hand.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ModelSource } from "../engine/catalog.js";
import { download, type DownloadProgress } from "../engine/download.js";
import type { SpeakersStatus } from "../../shared/ipc.js";
import type { Line } from "./live.js";
import { RATE } from "./segmenter.js";

/** One of the others, as the program numbered them; the name is the user's, empty until given. */
export interface Speaker {
  id: number;
  name: string;
}

/** A stretch one voice speaks in, in seconds from the start of the recording. */
export interface Turn {
  start: number;
  end: number;
  voice: number;
}

/** The sherpa-onnx release the program is built from; scripts/build-speakers.sh must agree. */
export const SPEAKERS_TAG = "v1.13.8";
const BINARY = "sherpa-onnx-offline-speaker-diarization";

/** Who speaks when: pyannote/segmentation-3.0 (MIT), in sherpa-onnx's conversion. */
export const SEGMENTATION_MODEL: ModelSource = {
  repo: "csukuangfj/sherpa-onnx-pyannote-segmentation-3-0",
  commit: "9403a6902bb58e3d5ae8c7e77c3422de279db2e0",
  file: "model.onnx",
  size: 5_992_913,
  sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};
const SEGMENTATION_FILE = "pyannote-segmentation-3.0.onnx";

/** Which voice is which: 3D-Speaker CAM++ trained on Chinese and English speakers (Apache-2.0). */
export const VOICE_MODEL: ModelSource = {
  repo: "csukuangfj/speaker-embedding-models",
  commit: "0743f301363dec56491a490f6d6cbc9d67f9a3bf",
  file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  size: 28_281_164,
  sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
};

const BYTES = SEGMENTATION_MODEL.size + VOICE_MODEL.size;

/**
 * How unlike two stretches must sound to be two people. On four recordings
 * of real voices 0.5 and 0.6 split a person in two in two of them and 0.8
 * made two people one; 0.65 was right in three and one person over in the
 * fourth. One too many is merged with a click; one too few has to be taken
 * apart line by line, so it leans towards too many.
 */
const THRESHOLD = 0.65;
/** A line no voice was heard in may take the voice next to it, this near, in seconds. */
const NEAR = 2;
/** The copy of the others' audio the program reads; made for it and removed after. */
export const SPEAKERS_WAV = "others.wav";
const MIN_TIMEOUT_MS = 5 * 60_000;

/**
 * The installed app carries the program in its resources; a development run
 * uses the one scripts/build-speakers.sh left in the build cache, or the one
 * VUNEMI_SPEAKERS_BINARY names.
 */
export function speakersBinary(opts: { packaged: boolean; resourcesPath: string; home: string; env?: NodeJS.ProcessEnv }): string | null {
  const path = opts.packaged
    ? join(opts.resourcesPath, BINARY)
    : opts.env?.VUNEMI_SPEAKERS_BINARY || join(opts.home, ".vunemi-build", "speakers-cache", SPEAKERS_TAG, BINARY);
  return existsSync(path) ? path : null;
}

/** "0.318 -- 6.865 speaker_00", one a line, among whatever else the program prints. */
export function parseTurns(output: string): Turn[] {
  return [...output.matchAll(/^\s*(\d+(?:\.\d+)?) -- (\d+(?:\.\d+)?) speaker_(\d+)\s*$/gm)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]), voice: Number(m[3]) }))
    .filter((turn) => turn.end > turn.start);
}

/**
 * Gives each of the others' lines the voice heard for most of it, and
 * numbers the voices in the order they first speak. A line with no voice
 * in it takes the nearest one when that is close, and stays unassigned
 * otherwise. A line two people share goes to the one who spoke more of it:
 * lines are cut at silences, not at changes of speaker.
 */
export function assignSpeakers(lines: readonly Line[], turns: readonly Turn[]): { lines: Line[]; speakers: Speaker[] } {
  const ids = new Map<number, number>();
  const out = lines.map((line) => {
    const { speaker: _was, ...rest } = line;
    if (line.source !== "others") return rest;
    const heard = new Map<number, number>();
    for (const turn of turns) {
      const shared = Math.min(line.end, turn.end) - Math.max(line.start, turn.start);
      if (shared > 0) heard.set(turn.voice, (heard.get(turn.voice) ?? 0) + shared);
    }
    let voice = [...heard].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (voice === undefined) {
      const gap = (turn: Turn): number => Math.max(turn.start - line.end, line.start - turn.end);
      const nearest = [...turns].sort((a, b) => gap(a) - gap(b))[0];
      if (nearest && gap(nearest) <= NEAR) voice = nearest.voice;
    }
    if (voice === undefined) return rest;
    if (!ids.has(voice)) ids.set(voice, ids.size + 1);
    return { ...rest, speaker: ids.get(voice)! };
  });
  return { lines: out, speakers: [...ids.values()].map((id) => ({ id, name: "" })) };
}

/** A name as the user typed it, tidied; empty takes the name away. */
export function speakerName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Speakers that still have a line, in their order. */
export function speakersLeft(lines: readonly Line[], speakers: readonly Speaker[]): Speaker[] {
  const used = new Set(lines.flatMap((line) => line.speaker ?? []));
  return speakers.filter((speaker) => used.has(speaker.id));
}

/** `text` with one way of calling a person replaced by another, where it stands as a name and not inside a word. */
export function renameIn(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "Person 1" must not match in "Person 12"; a suffix after an apostrophe ("Kişi 1'in") may follow.
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), () => to);
}

/** The others' raw audio with a WAV header in front, for a program that reads files. */
export async function wavFromPcm(pcm: string, wav: string): Promise<void> {
  const bytes = statSync(pcm).size & ~1;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  const out = createWriteStream(wav, { mode: 0o600 });
  out.write(header);
  await pipeline(createReadStream(pcm, { end: Math.max(0, bytes - 1) }), out);
}

export interface SpeakerSeparatorOptions {
  /** The sherpa-onnx program; null when this build has none. */
  binary: string | null;
  /** Where the two models are kept. */
  dir: string;
  onChange?: (status: SpeakersStatus) => void;
  /** Replaced in tests. */
  download?: typeof download;
  run?: (binary: string, args: string[], signal: AbortSignal) => Promise<string>;
}

/** Runs the program and gives back what it printed; it prints the turns among its progress. */
function runProgram(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "";
    const keep = (chunk: Buffer): void => {
      // Progress lines are most of it; the turns are short. Keep the end if it ever grows absurd.
      out = (out + chunk.toString("utf8")).slice(-4_000_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`The speaker program ended with ${code ?? "a signal"}.`))));
  });
}

export class SpeakerSeparator {
  private downloading: { controller: AbortController; received: number; done: Promise<void> } | null = null;

  constructor(private readonly opts: SpeakerSeparatorOptions) {}

  private get segmentation(): string {
    return join(this.opts.dir, SEGMENTATION_FILE);
  }

  private get voices(): string {
    return join(this.opts.dir, VOICE_MODEL.file);
  }

  /** The program and both models are here. */
  ready(): boolean {
    return !!this.opts.binary && existsSync(this.segmentation) && existsSync(this.voices);
  }

  status(): SpeakersStatus {
    if (!this.opts.binary) return { state: "unavailable" };
    if (this.ready()) return { state: "ready", bytes: BYTES };
    if (this.downloading) return { state: "downloading", bytes: BYTES, received: this.downloading.received };
    return { state: "absent", bytes: BYTES };
  }

  /** The two pinned files, each checked by SHA-256, only when the user presses the button. */
  async download(): Promise<SpeakersStatus> {
    if (!this.opts.binary || this.ready()) return this.status();
    if (!this.downloading) {
      const controller = new AbortController();
      const state: NonNullable<SpeakerSeparator["downloading"]> = { controller, received: 0, done: Promise.resolve() };
      const fetchOne = this.opts.download ?? download;
      const progress = (before: number) => (p: DownloadProgress) => {
        state.received = before + p.received;
        this.opts.onChange?.(this.status());
      };
      this.downloading = state;
      state.done = (async () => {
        await fetchOne(SEGMENTATION_MODEL, this.opts.dir, { signal: controller.signal, saveAs: SEGMENTATION_FILE, onProgress: progress(0) });
        await fetchOne(VOICE_MODEL, this.opts.dir, { signal: controller.signal, onProgress: progress(SEGMENTATION_MODEL.size) });
      })();
      this.opts.onChange?.(this.status());
    }
    const running = this.downloading;
    try {
      await running.done;
    } finally {
      if (this.downloading === running) this.downloading = null;
      this.opts.onChange?.(this.status());
    }
    return this.status();
  }

  cancelDownload(): void {
    this.downloading?.controller.abort();
  }

  /**
   * Who speaks when in the others' audio of the meeting in `folder`. Throws
   * when it cannot say; the meeting is then written as it was before, with
   * the others as one.
   */
  async separate(folder: string, signal?: AbortSignal): Promise<Turn[]> {
    const pcm = join(folder, "system.pcm");
    if (!this.ready() || !existsSync(pcm)) throw new Error("Speaker separation is not ready.");
    const wav = join(folder, SPEAKERS_WAV);
    const seconds = statSync(pcm).size / 2 / RATE;
    // A minute of audio took about five seconds; a slow Mac gets as long as the meeting itself.
    const limit = AbortSignal.timeout(Math.max(MIN_TIMEOUT_MS, Math.ceil(seconds * 1000)));
    const threads = String(Math.max(1, Math.min(4, Math.floor(cpus().length / 2))));
    try {
      await wavFromPcm(pcm, wav);
      const out = await (this.opts.run ?? runProgram)(
        this.opts.binary!,
        [
          `--clustering.cluster-threshold=${THRESHOLD}`,
          `--segmentation.num-threads=${threads}`,
          `--embedding.num-threads=${threads}`,
          `--segmentation.pyannote-model=${this.segmentation}`,
          `--embedding.model=${this.voices}`,
          wav,
        ],
        signal ? AbortSignal.any([signal, limit]) : limit,
      );
      return parseTurns(out);
    } finally {
      // A copy of system.pcm with a header in front: the audio itself goes to the Trash with the rest.
      rmSync(wav, { force: true });
    }
  }
}
