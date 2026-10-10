/**
 * Writes a meeting down while it happens. The recorder appends to mic.pcm
 * ("Me") and system.pcm ("Others"); this reads what is new every half second,
 * cuts it at silences and sends each stretch to whisper, one at a time,
 * oldest first. Recording never waits for it: if whisper falls behind the
 * stretches queue, and Stop waits for the queue before the summary.
 *
 * On speakers the microphone hears the others too. A "Me" stretch is written
 * only after the system audio up to its end has been, and is dropped when it
 * repeats what the others said at the same time.
 *
 * The same class finishes a meeting Vunemi quit during: started on files
 * that are already complete, it reads them from the beginning.
 */
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Locale } from "@vunemi/i18n";
import { silencePhrase } from "./filter.js";
import { Segmenter, wav, type Segment } from "./segmenter.js";

export type Source = "me" | "others";

export interface Line {
  source: Source;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  /** Which of the others said it, once they were told apart (speakers.ts); never on "me". */
  speaker?: number;
}

export type Transcribe = (wav: Buffer, language: Locale | "auto") => Promise<{ text: string; language: Locale; noSpeech: number }>;

const FILES: Record<Source, string> = { me: "mic.pcm", others: "system.pcm" };
/** Speech heard before the meeting's language is settled for good. */
const SETTLE_SECONDS = 60;
/** Above this whisper believes nothing was said, whatever it wrote. */
const NO_SPEECH = 0.6;
const READ_BYTES = 1 << 20;
/** How far apart in time an echo and what it echoes may be, in seconds. */
const ECHO_WINDOW = 2;
/** Share of a "Me" line's words that must be in the others' line for it to be an echo. */
const ECHO_SHARE = 0.6;
/** A "Me" stretch waits at most this long, in seconds of recording, for the system audio. */
const ECHO_WAIT = 8;

function words(text: string): string[] {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Whether `mine` is mostly the others' words: the microphone hearing the speakers. */
export function echoes(mine: string, theirs: string): boolean {
  const own = words(mine);
  if (own.length === 0) return false;
  const heard = new Set(words(theirs));
  return own.filter((w) => heard.has(w)).length / own.length >= ECHO_SHARE;
}

interface Tail {
  source: Source;
  path: string;
  file: FileHandle | null;
  offset: number;
  /** An odd byte left over from the last read. */
  odd: Buffer;
  segmenter: Segmenter;
}

export class LiveTranscript {
  private readonly tails: Tail[];
  private readonly queue: { source: Source; segment: Segment }[] = [];
  private readonly heard = new Map<Locale, number>();
  private fixed: Locale | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading: Promise<void> = Promise.resolve();
  private working: Promise<void> | null = null;
  private busy = false;
  private finishing = false;
  private transcriptionFailures = 0;
  /** The others' recent lines, to tell an echo from the user. */
  private others: Line[] = [];

  constructor(
    private readonly opts: {
      dir: string;
      transcribe: Transcribe;
      onLine: (line: Line) => void;
      pollMs?: number;
      /** A meeting whose language is already known (a recovered one). */
      language?: Locale | null;
    },
  ) {
    this.fixed = opts.language ?? null;
    this.tails = (Object.keys(FILES) as Source[]).map((source) => ({
      source,
      path: join(opts.dir, FILES[source]),
      file: null,
      offset: 0,
      odd: Buffer.alloc(0),
      segmenter: new Segmenter(),
    }));
  }

  get language(): Locale | null {
    return this.fixed;
  }

  /** Stretches waiting for whisper, the one it is on included. */
  get pending(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  get failedSegments(): number {
    return this.transcriptionFailures;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 500);
    this.timer.unref?.();
  }

  /** After the recorder stopped: reads the rest, closes the last stretches, waits for whisper. */
  async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.poll();
    this.finishing = true;
    for (const tail of this.tails) {
      this.enqueue(tail.source, tail.segmenter.flush());
      await tail.file?.close().catch(() => {});
      tail.file = null;
    }
    this.work();
    while (this.working) await this.working;
  }

  // -- internals -------------------------------------------------------------

  private poll(): Promise<void> {
    this.reading = this.reading.then(async () => {
      for (const tail of this.tails) {
        try {
          await this.read(tail);
        } catch (err) {
          console.error("[vunemi meetings] reading", tail.source, (err as Error).message);
        }
      }
      this.work();
    });
    return this.reading;
  }

  private async read(tail: Tail): Promise<void> {
    if (!tail.file) {
      try {
        tail.file = await open(tail.path, "r");
      } catch {
        return; // not written yet
      }
    }
    for (;;) {
      const buffer = Buffer.alloc(READ_BYTES);
      const { bytesRead } = await tail.file.read(buffer, 0, READ_BYTES, tail.offset);
      if (bytesRead === 0) return;
      tail.offset += bytesRead;
      const bytes = Buffer.concat([tail.odd, buffer.subarray(0, bytesRead)]);
      const even = bytes.length - (bytes.length % 2);
      tail.odd = Buffer.from(bytes.subarray(even));
      const samples = new Int16Array(even / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      this.enqueue(tail.source, tail.segmenter.push(samples));
      if (bytesRead < READ_BYTES) return;
    }
  }

  private enqueue(source: Source, segments: Segment[]): void {
    for (const segment of segments) this.queue.push({ source, segment });
    this.queue.sort((a, b) => a.segment.start - b.segment.start);
  }

  private work(): void {
    if (this.working || this.queue.length === 0) return;
    this.working = (async () => {
      for (let next = this.next(); next; next = this.next()) {
        this.busy = true;
        try {
          await this.transcribe(next.source, next.segment);
        } catch (err) {
          // One stretch lost is better than a meeting stuck; the rest go on.
          this.transcriptionFailures++;
          console.error("[vunemi meetings] transcribing", (err as Error).message);
        } finally {
          this.busy = false;
        }
      }
    })().finally(() => {
      this.working = null;
    });
  }

  /** The oldest stretch that may go now: a "Me" one only once the others' audio around it is written. */
  private next(): { source: Source; segment: Segment } | undefined {
    const [me, others] = [this.tails[0]!.segmenter, this.tails[1]!.segmenter];
    const index = this.queue.findIndex(
      ({ source, segment }) =>
        source === "others" ||
        ((this.finishing || segment.end + ECHO_WINDOW <= others.settled || me.heard - segment.end > ECHO_WAIT) &&
          !this.queue.some((q) => q.source === "others" && q.segment.start <= segment.end + ECHO_WINDOW)),
    );
    return index === -1 ? undefined : this.queue.splice(index, 1)[0];
  }

  private async transcribe(source: Source, segment: Segment): Promise<void> {
    const heard = await this.opts.transcribe(wav(segment.samples), this.fixed ?? "auto");
    if (heard.noSpeech > NO_SPEECH || silencePhrase(heard.text)) return;
    const line: Line = { source, start: segment.start, end: segment.end, text: heard.text.trim() };
    if (source === "others") {
      this.others = [...this.others.filter((l) => l.end > line.start - 60), line];
    } else if (this.others.some((l) => l.start <= line.end + ECHO_WINDOW && l.end >= line.start - ECHO_WINDOW && echoes(line.text, l.text))) {
      return;
    }
    if (!this.fixed) this.settle(heard.language, segment.end - segment.start);
    this.opts.onLine(line);
  }

  /** After a minute of speech the meeting's language is the one heard most, and stays. */
  private settle(language: Locale, seconds: number): void {
    this.heard.set(language, (this.heard.get(language) ?? 0) + seconds);
    const total = [...this.heard.values()].reduce((a, b) => a + b, 0);
    if (total < SETTLE_SECONDS) return;
    this.fixed = [...this.heard.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
}
