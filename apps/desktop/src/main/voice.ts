/**
 * Voice, and it stays on this Mac: whisper.cpp with Metal for hearing,
 * macOS's own speech synthesiser for talking. No audio leaves the machine,
 * and nothing here is required — if whisper isn't installed Vunemi says so and
 * the keyboard keeps working.
 *
 * Both come with Vunemi: the whisper server is built into the app
 * (scripts/build-whisper.sh), and the model is downloaded from inside the app
 * the first time, pinned and checked. A Homebrew whisper is still used when
 * there is no built-in one (a development run without the build cache).
 *
 * The model takes memory, so it is not loaded until someone actually speaks, and
 * it is let go after a few idle minutes: Vunemi shares this memory with the
 * language model. Between those two points whisper stays resident as a local
 * sidecar, which is the difference between ~3 s and ~200 ms an utterance.
 *
 * The renderer captures the microphone (only it can) and hands over finished
 * 16 kHz mono WAV bytes; everything that spawns a process lives here.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLocale, t, type Locale } from "@vunemi/i18n";

import type { VoiceStatus } from "../shared/ipc.js";
import { download, type DownloadProgress } from "./engine/download.js";
import type { ModelSource } from "./engine/catalog.js";

export type { VoiceStatus };

/** The whisper.cpp release built into the app; scripts/build-whisper.sh must agree. */
export const WHISPER_TAG = "v1.9.4";

/**
 * The speech model Vunemi downloads: large-v3-turbo, quantised to 5 bits.
 * On the local 11-language set it made the same mistakes as the full 1.6 GB
 * model (4 in 86 Turkish words, none elsewhere) in a third of the download
 * and half the memory.
 */
export const VOICE_MODEL: ModelSource = {
  repo: "ggerganov/whisper.cpp",
  commit: "5359861c739e955e79d9a303bcbc70fb988958b1",
  file: "ggml-large-v3-turbo-q5_0.bin",
  size: 574_041_195,
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};

/** The built-in whisper server: in the app's resources, or a development run's build cache. */
export function whisperBinary(opts: { packaged: boolean; resourcesPath: string; home: string }): string | null {
  const path = opts.packaged
    ? join(opts.resourcesPath, "whisper-server")
    : join(opts.home, ".vunemi-build", "whisper-cache", WHISPER_TAG, "whisper-server");
  return existsSync(path) ? path : null;
}

/**
 * The voice macOS speaks each language with; `say -v '?'` lists them. One
 * that is not installed is left out, and the system's own voice speaks.
 */
const VOICES: Record<Locale, string> = {
  tr: "Yelda", en: "Samantha", de: "Anna", fr: "Thomas", es: "Mónica", it: "Alice",
  pt: "Luciana", ru: "Milena", zh: "Tingting", ja: "Kyoko", ko: "Yuna",
};

let installedVoices: Set<string> | null = null;

/**
 * The language a reply is written in, when the writing itself says so: its
 * script, or letters only one of Vunemi's languages uses. Null when it
 * doesn't ("Dört" could be German), and the speaker's language decides.
 */
export function writtenIn(text: string): Locale | null {
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return "ko";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[ğşıİĞŞ]/.test(text)) return "tr";
  if (/[ß]/.test(text)) return "de";
  if (/[ñ¿¡]/.test(text)) return "es";
  if (/[ãõ]/.test(text)) return "pt";
  return null;
}

/**
 * How much likelier another language must be before Vunemi stops hearing the
 * app's own: a full sentence clears it easily, a single word never does.
 */
const CONFIDENT = 0.5;
const CLEARLY_LIKELIER = 2;

/**
 * Which of Vunemi's languages was spoken. The app's language unless whisper
 * is sure of another: on one word it is not, and a Turkish "selam" came back
 * as Persian letters, then as English "Salam" and "Salaam". Whisper's own
 * guess among its hundred languages counts only when it is one of ours.
 */
export function spokenIn(probabilities: Record<string, number> | undefined, expected: Locale): Locale {
  const p = (code: string) => probabilities?.[code] ?? 0;
  let best: Locale = expected;
  for (const code of Object.keys(VOICES) as Locale[]) if (p(code) > p(best)) best = code;
  return best !== expected && p(best) >= CONFIDENT && p(best) >= CLEARLY_LIKELIER * p(expected) ? best : expected;
}

function voiceFor(locale: Locale): string | null {
  if (installedVoices === null) {
    try {
      const listing = execFileSync("/usr/bin/say", ["-v", "?"], { encoding: "utf8", timeout: 5_000 });
      installedVoices = new Set(listing.split("\n").map((line) => line.split(/\s{2,}|\s\(/)[0]!.trim()).filter(Boolean));
    } catch {
      installedVoices = new Set();
    }
  }
  const name = VOICES[locale];
  return installedVoices.has(name) ? name : null;
}

const SERVER_PATHS = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"];

/** Long enough to survive a pause in dictation, short enough to give the RAM back. */
const IDLE_MS = 5 * 60_000;
/** Loading a large model into Metal takes a couple of seconds, cold. */
const READY_TIMEOUT_MS = 60_000;
/** A minute of speech transcribes in seconds; longer than this is a fault. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

interface Heard {
  text?: string;
  language_probabilities?: Record<string, number>;
  segments?: { no_speech_prob?: number; t0?: number; t1?: number; start?: number; end?: number }[];
}

/** Whisper's no-speech belief over a clip, each part weighed by its length. */
export function noSpeech(segments: Heard["segments"]): number {
  let weight = 0;
  let sum = 0;
  for (const s of segments ?? []) {
    if (typeof s.no_speech_prob !== "number") continue;
    const length = Math.max((s.end ?? s.t1 ?? 1) - (s.start ?? s.t0 ?? 0), 0.01);
    weight += length;
    sum += s.no_speech_prob * length;
  }
  return weight ? sum / weight : 0;
}

export class Voice {
  /** The language of the user's last spoken turn. */
  private heardLanguage: Locale | null = null;
  private server: ChildProcess | null = null;
  private port = 0;
  private ready: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Transcriptions under way, from asking for the server to the last word: the model manager never stops it under one. */
  private inflight = 0;
  private speaking: ChildProcess | null = null;
  /** Sentences are made one at a time, in the order they were asked for. */
  private making: Promise<unknown> = Promise.resolve();
  /** Goes up when the talking is stopped: sentences still waiting to be made are not. */
  private spokenTurn = 0;
  /** Sentences left behind by a Vunemi that quit while one was being made are removed once. */
  private swept = false;
  private binary: string | null;
  private model: string | null;
  private downloading: { controller: AbortController; progress: DownloadProgress | null; done: Promise<string> } | null = null;

  private readonly builtIn: string | null;
  private readonly onChange: (status: VoiceStatus) => void;
  private readonly downloadModel: typeof download;
  private readonly shared: boolean;

  constructor(
    private readonly userData: string,
    opts: {
      /** The whisper server that came with the app (whisperBinary), if any. */
      builtIn?: string | null;
      /** Told how a model download is going. */
      onChange?: (status: VoiceStatus) => void;
      /** Replaced in tests. */
      download?: typeof download;
      /** Also look in the folders earlier builds and other tools used. */
      shared?: boolean;
    } = {},
  ) {
    this.builtIn = opts.builtIn ?? null;
    this.onChange = opts.onChange ?? (() => {});
    this.downloadModel = opts.download ?? download;
    this.shared = opts.shared ?? true;
    this.binary = findBinary(this.builtIn);
    this.model = findModel(userData, this.shared);
  }

  /** Cheap enough to call whenever the composer appears. */
  status(): VoiceStatus {
    // Re-probe: the user may have installed whisper while Vunemi was running.
    this.binary ??= findBinary(this.builtIn);
    this.model ??= findModel(this.userData, this.shared);
    if (this.binary && this.model) {
      return { canHear: true, canSpeak: true, engine: `whisper.cpp · ${modelLabel(this.model)}` };
    }
    if (!this.binary) return { canHear: false, canSpeak: true, engine: "", hint: t("voiceEngine.noWhisper") };
    const progress = this.downloading?.progress;
    return {
      canHear: false,
      canSpeak: true,
      engine: "",
      hint: t("voiceEngine.noModel", { size: megabytes(VOICE_MODEL.size) }),
      download: { bytes: VOICE_MODEL.size },
      ...(this.downloading && { downloading: { received: progress?.received ?? 0, total: progress?.total ?? VOICE_MODEL.size } }),
    };
  }

  /**
   * Downloads the speech model into Vunemi's own models folder: a pinned file,
   * checked against its SHA-256 before it is used, carried on from where it
   * stopped if the connection drops. The user asked for it by pressing the
   * button; nothing downloads by itself.
   */
  async download(): Promise<VoiceStatus> {
    if (!this.downloading) {
      const controller = new AbortController();
      // Kept before the download starts: progress may be reported at once.
      const state: NonNullable<Voice["downloading"]> = { controller, progress: null, done: Promise.resolve("") };
      this.downloading = state;
      state.done = this.downloadModel(VOICE_MODEL, join(this.userData, "models"), {
        signal: controller.signal,
        onProgress: (p) => {
          state.progress = p;
          this.onChange(this.status());
        },
      });
      this.onChange(this.status());
    }
    const running = this.downloading;
    try {
      this.model = await running.done;
    } finally {
      if (this.downloading === running) this.downloading = null;
      this.onChange(this.status());
    }
    return this.status();
  }

  cancelDownload(): void {
    this.downloading?.controller.abort();
  }

  /**
   * 16 kHz mono WAV in, text out. Heard in the app's language unless the
   * speech is clearly in another of Vunemi's: forced into one language,
   * Turkish speech in an English Vunemi came back as broken English; left to
   * guess, a Turkish "selam" came back as Persian.
   */
  async transcribe(wav: Buffer): Promise<string> {
    this.inflight++;
    try {
      await this.start("auto");
      this.touch();

      const heard = await this.inference(wav, "auto");
      // Whisper's code for what it heard, e.g. "tr"; the name ("turkish") is in `language`.
      const code = Object.entries(heard.language_probabilities ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
      const ours = spokenIn(heard.language_probabilities, getLocale());
      this.heardLanguage = ours;
      // Whisper wrote it down in another language than the one decided on: again, in that one.
      if (code !== ours) return clean((await this.inference(wav, ours)).text ?? "");
      return clean(heard.text ?? "");
    } finally {
      this.inflight--;
    }
  }

  /**
   * One stretch of a meeting. Unlike dictation it may be in a language fixed
   * for the whole meeting; "auto" lets whisper judge, within Vunemi's
   * languages. `noSpeech` is whisper's own belief that nothing was said.
   */
  async clip(wav: Buffer, language: Locale | "auto"): Promise<{ text: string; language: Locale; noSpeech: number }> {
    this.inflight++;
    try {
      await this.start("auto");
      this.touch();
      let heard = await this.inference(wav, language);
      const spoken: Locale = language === "auto" ? spokenIn(heard.language_probabilities, getLocale()) : language;
      const code = Object.entries(heard.language_probabilities ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (language === "auto" && code !== spoken) heard = await this.inference(wav, spoken);
      this.touch();
      return { text: clean(heard.text ?? ""), language: spoken, noSpeech: noSpeech(heard.segments) };
    } finally {
      this.inflight--;
    }
  }

  private async inference(wav: Buffer, language: string): Promise<Heard> {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
    body.append("response_format", "verbose_json");
    body.append("language", language);
    body.append("temperature", "0");

    // Never open-ended: a request that hangs would leave the UI saying it
    // is working with nothing behind it.
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(t("voiceEngine.failed", { status: res.status }));
    const payload = (await res.json()) as Heard & { error?: string };
    if (payload.error) throw new Error(payload.error);
    return payload;
  }

  /**
   * One sentence as sound: a WAV the window plays itself, so that it can
   * stop in the middle of a word and its echo canceller knows what is being
   * played. Empty when the talking was stopped before this one's turn.
   */
  synthesize(text: string): Promise<Buffer> {
    const said = text.trim().slice(0, 1200);
    if (!said) return Promise.resolve(Buffer.alloc(0));
    const turn = this.spokenTurn;
    const made = this.making.then(() => (turn === this.spokenTurn ? this.say(said) : Buffer.alloc(0)));
    this.making = made.catch(() => {});
    return made;
  }

  private say(said: string): Promise<Buffer> {
    // In the reply's own language, not the app's: an English Vunemi read
    // "Dört" with an English voice. The writing decides when it can; else
    // the language the user just spoke, which the reply answers in.
    const voice = voiceFor(writtenIn(said) ?? this.heardLanguage ?? getLocale());
    const dir = join(this.userData, "speech");
    if (!this.swept) rmSync(dir, { recursive: true, force: true });
    this.swept = true;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.wav`);
    // Arguments, never a shell: this is model output and may contain anything.
    const child = spawn("/usr/bin/say", [...(voice ? ["-v", voice] : []), "-r", "190", "-o", file, "--data-format=LEI16@22050", "--", said], { stdio: "ignore" });
    this.speaking = child;
    return new Promise<Buffer>((resolve, reject) => {
      const done = (code: number | null) => {
        if (this.speaking === child) this.speaking = null;
        try {
          if (code === 0) resolve(readFileSync(file));
          else reject(new Error("say"));
        } catch (err) {
          reject(err as Error);
        } finally {
          // The sound is in the window now; the file was only the way there.
          rmSync(file, { force: true });
        }
      };
      child.on("exit", done);
      child.on("error", () => done(null));
    });
  }

  /** Nothing more is made of what was asked for so far. */
  stopSpeaking(): void {
    this.spokenTurn += 1;
    this.speaking?.kill();
    this.speaking = null;
  }

  dispose(): void {
    this.cancelDownload();
    this.stopSpeaking();
    this.shutdown();
  }

  // -- the sidecar -----------------------------------------------------------

  /** Starts whisper-server if it isn't up; concurrent callers share one start. */
  private start(language: string): Promise<void> {
    if (this.ready) return this.ready;
    const { binary, model } = this;
    if (!binary || !model) return Promise.reject(new Error(this.status().hint ?? t("composer.voice.unavailable")));

    this.ready = (async () => {
      const port = await freePort();
      const child = spawn(
        binary,
        [
          "-m", model,
          "--host", "127.0.0.1", // never reachable from outside this Mac
          "--port", String(port),
          "-l", language,
          "--no-timestamps",
          // Silence invites invention; these two make whisper likelier to
          // return nothing at all, which is the honest answer.
          "--suppress-nst",
          // Lower than the default 0.6: a segment whisper half-suspects is
          // silence should be dropped, not guessed at.
          "-nth", "0.3",
          "-t", "4",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      this.server = child;
      this.port = port;

      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr = `${stderr}${d.toString()}`.slice(-2000);
      });
      child.on("exit", () => {
        if (this.server === child) this.reset();
      });

      try {
        await waitForPort(port, child, READY_TIMEOUT_MS);
      } catch (err) {
        child.kill();
        this.reset();
        throw new Error(t("voiceEngine.startFailed", { why: `${(err as Error).message}${stderr ? `\n${stderr.trim().split("\n").at(-1)}` : ""}` }));
      }
      this.touch();
    })();

    return this.ready;
  }

  busy(): boolean {
    return this.inflight > 0;
  }

  /** The whisper server's process while one runs. It reads its model into its own memory, so the footprint is all of it. */
  pid(): number | null {
    return this.server?.pid ?? null;
  }

  /** Lets the model go now rather than after the idle minutes; the next clip starts it again. */
  unload(): void {
    this.shutdown();
  }

  /** The model is big; hand the memory back once the user stops dictating. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  private shutdown(): void {
    this.server?.kill();
    this.reset();
  }

  private reset(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.server = null;
    this.ready = null;
    this.port = 0;
  }
}

// -- finding what's installed -------------------------------------------------

function exists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The built-in server first; Homebrew's only when the app has none. */
function findBinary(builtIn: string | null): string | null {
  if (builtIn && exists(builtIn)) return builtIn;
  return SERVER_PATHS.find(exists) ?? null;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/** Where a model may live, most specific first. */
function modelDirs(userData: string): string[] {
  return [
    join(userData, "models"),
    join(homedir(), ".cache", "whisper"),
  ];
}

/** The most capable ggml model we can find: bigger is better at Turkish. */
export function findModel(userData: string, shared = true): string | null {
  const fromEnv = process.env.VUNEMI_WHISPER_MODEL;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  for (const dir of shared ? modelDirs(userData) : [join(userData, "models")]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const models = names.filter((n) => n.startsWith("ggml-") && n.endsWith(".bin")).sort();
    const best =
      models.find((n) => n.includes("large")) ??
      models.find((n) => n.includes("medium")) ??
      models.find((n) => n.includes("small")) ??
      models[0];
    if (best) return join(dir, best);
  }
  return null;
}

function modelLabel(path: string): string {
  return path.replace(/^.*ggml-/, "").replace(/\.bin$/, "");
}

// -- process plumbing ---------------------------------------------------------

/** Asks the OS for a port nobody is using, then gives it straight back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Waits for the sidecar to answer, and gives up early if it died instead. */
async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error("the process exited unexpectedly");
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("the model did not load");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/**
 * What whisper says when it heard nothing: sentences from the subtitle files
 * it was trained on. They are not transcription, they are the model filling a
 * gap, and passing them on as a task would be worse than silence. Matched
 * whole, so someone who genuinely says one can still type it.
 */
const FILLER = new Set(
  [
    "izlediğiniz için teşekkür ederim.",
    "izlediğiniz için teşekkürler.",
    "abone olmayı unutmayın.",
    "altyazı m.k.",
    "altyazı m.k",
    "thank you for watching.",
    "thanks for watching!",
    "you",
  ].map((t) => t.toLocaleLowerCase("tr")),
);

/**
 * whisper prints bracketed noises for silence ("[BLANK_AUDIO]", "(müzik)")
 * and pads with newlines. None of that belongs in a prompt.
 */
export function clean(text: string): string {
  const said = text
    .replace(/\[[^\]\n]{0,40}\]/g, " ")
    .replace(/\((?:müzik|music|sessizlik|silence)[^)\n]{0,20}\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return FILLER.has(said.toLocaleLowerCase("tr")) ? "" : said;
}
