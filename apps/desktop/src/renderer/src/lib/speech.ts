/**
 * Talking, as a conversation needs it: the reply is said sentence by sentence
 * while it is still being written, and it is played inside the window.
 *
 * Sentence by sentence, because a reply read only once it is finished starts
 * after a silence as long as the reply. Inside the window, for two reasons:
 * a sound the window plays can be stopped in the middle of a word, and the
 * microphone's echo canceller knows it, so the user can speak over Vunemi
 * without Vunemi hearing itself.
 *
 * The voice itself is made in the main process (voice.ts); this file decides
 * what is said and when.
 */
import { t } from "@vunemi/i18n";
import { speakable } from "./fold.js";

/** Where a sentence ends: its mark and what closes it, then a space; the full-width marks need no space. */
const END = /[.!?…][)"'”’\]]*\s|[。！？]/g;
/** Shorter than this is said together with what follows: "Evet." alone is a voice starting and stopping. */
const MIN_CHARS = 12;

/**
 * Cuts a reply into things to say, as it arrives. What it gives is final:
 * a sentence handed out is never taken back, so it can be said at once.
 */
export class SentenceCutter {
  /** Written, not yet cut: the line still being written. */
  private rest = "";
  /** Too short to say alone. */
  private carry = "";
  private fenced = false;

  /** More of the reply. Returns the sentences that are now complete. */
  push(delta: string): string[] {
    this.rest += delta;
    const out: string[] = [];
    for (let at = this.rest.indexOf("\n"); at >= 0; at = this.rest.indexOf("\n")) {
      this.line(this.rest.slice(0, at), out);
      this.rest = this.rest.slice(at + 1);
    }
    // In the line still being written: each sentence that has ended.
    // A line that may yet turn out to open a code block waits for its end.
    if (!this.fenced && !this.rest.trimStart().startsWith("`")) this.rest = this.ended(this.rest, out);
    return out;
  }

  /** The reply is over: whatever is left, short or not. */
  flush(): string[] {
    const out: string[] = [];
    this.line(this.rest, out);
    if (this.carry) out.push(this.carry);
    this.rest = "";
    this.carry = "";
    this.fenced = false;
    return out;
  }

  /** A whole line. Its end ends a sentence: headings and list items carry no full stop. */
  private line(line: string, out: string[]): void {
    if (/^\s*```/.test(line)) {
      // Code is named, not read.
      if (!this.fenced) this.piece(`${t("voice.codeBlock")}.`, out);
      this.fenced = !this.fenced;
      return;
    }
    if (this.fenced) return;
    this.piece(this.ended(line, out), out, true);
  }

  /** Hands out the sentences of a line that have ended, and returns what follows the last of them. */
  private ended(text: string, out: string[]): string {
    let from = 0;
    for (const end of text.matchAll(END)) {
      // "1. " opens a list item; it ends nothing.
      if (/^\s*\d{1,3}$/.test(text.slice(from, end.index))) continue;
      const to = end.index + end[0].length;
      this.piece(text.slice(from, to), out);
      from = to;
    }
    return text.slice(from);
  }

  private piece(text: string, out: string[], closes = false): void {
    let said = speakable(text)
      // An address is said by its site: nobody wants a path read to them.
      .replace(/https?:\/\/(?:www\.)?([^/\s)]+)\S*/g, "$1")
      // Marks left over from a pair cut in two, and a table's bars.
      .replace(/[*_`#|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // A rule or a table's dividing line: nothing to say.
    if (!/[\p{L}\p{N}]/u.test(said)) return;
    if (closes && !/[.!?…:;,。！？]$/.test(said)) said += ".";
    this.carry = this.carry ? `${this.carry} ${said}` : said;
    if (this.carry.length >= MIN_CHARS) {
      out.push(this.carry);
      this.carry = "";
    }
  }
}

/** One clip being played: `done` settles when it ends or is stopped. */
export interface Playing {
  done: Promise<void>;
  stop(): void;
}

export interface SpeechPlayerOptions {
  /** A sentence as a WAV; the main process makes it. */
  synthesize(text: string): Promise<ArrayBuffer>;
  /** Replaced in tests, where there is nothing to play through. */
  play?: (wav: ArrayBuffer) => Playing;
}

let output: AudioContext | null = null;

/** Plays a WAV through the window's own audio. */
export function playWav(wav: ArrayBuffer): Playing {
  let source: AudioBufferSourceNode | null = null;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  try {
    output ??= new AudioContext();
    const context = output;
    void context.resume();
    context.decodeAudioData(wav.slice(0)).then((buffer) => {
      if (stopped) return;
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = finish;
      source.start();
    }, finish);
  } catch {
    // No audio output: the reply is still on the screen.
    finish();
  }
  return {
    done,
    stop() {
      stopped = true;
      try {
        source?.stop();
      } catch {
        // Not started yet.
      }
      finish();
    },
  };
}

/**
 * Says sentences one after another, in the order they were given. Each is
 * sent to be made as soon as it is known, so the next one is usually ready
 * by the time the one before it has been said.
 */
export class SpeechPlayer {
  private queue: Promise<ArrayBuffer | null>[] = [];
  private current: Playing | null = null;
  private running = false;
  /** Goes up at every stop: what was under way before it is nobody's any more. */
  private generation = 0;
  private waiting: (() => void)[] = [];
  private readonly play: (wav: ArrayBuffer) => Playing;

  constructor(private readonly opts: SpeechPlayerOptions) {
    this.play = opts.play ?? playWav;
  }

  say(text: string): void {
    // A sentence that could not be made is skipped; the ones after it are still said.
    this.queue.push(this.opts.synthesize(text).catch(() => null));
    void this.pump();
  }

  /** Resolves when everything given so far has been said, or at once after a stop. */
  finished(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Quiet, now: in the middle of a word, and nothing of what was waiting is said. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.running = false;
    this.current?.stop();
    this.current = null;
    this.settle();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const mine = this.generation;
    while (this.queue.length > 0) {
      const wav = await this.queue.shift()!;
      if (mine !== this.generation) return;
      if (!wav) continue;
      this.current = this.play(wav);
      await this.current.done;
      if (mine !== this.generation) return;
      this.current = null;
    }
    this.running = false;
    this.settle();
  }

  private settle(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}
