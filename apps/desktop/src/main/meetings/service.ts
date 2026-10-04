/**
 * A meeting from the Record button to its summary. Recording starts only
 * from the user's button (IPC from the window); no tool and no automation
 * reaches this.
 *
 *   recording → transcribing (whisper catches up) → summarising → done
 *                                                               ↘ failed
 *
 * A failed summary keeps the transcript and can be tried again. After a
 * summary the audio goes to the Trash. A meeting Vunemi quit during is found
 * at the next launch and finished from its files.
 */
import { rmSync } from "node:fs";
import type { ChatModel } from "@vunemi/agent-core";
import type { Locale } from "@vunemi/i18n";
import { LiveTranscript, type Line, type Transcribe } from "./live.js";
import type { Levels, Recorder } from "./recorder.js";
import type { Meeting, MeetingStore } from "./store.js";
import { summarise, type Headings, type Names } from "./summary.js";

/** Why the Record button cannot record, or null when it can. */
export type MeetingBlock = "macos" | "recorder" | "voice";

export interface MeetingStatus {
  recording: { id: string; startedAt: number; lines: Line[]; pending: number } | null;
  blocked: MeetingBlock | null;
}

export interface MeetingWords {
  names: Names;
  headings: Headings;
  /** The language's English name, for the model. */
  language: string;
}

export interface MeetingServiceOptions {
  store: MeetingStore;
  recorder: Recorder;
  transcribe: Transcribe;
  /** The chat model for summaries, ready to answer, with its window in tokens. */
  model: (spec: string) => Promise<{ model: ChatModel; window: number }>;
  /** Names and headings in the meeting's language (the app's when unknown). */
  words: (language: Locale | null) => MeetingWords;
  blocked: () => MeetingBlock | null;
  onChange: (status: MeetingStatus) => void;
  onLine: (id: string, line: Line) => void;
  /** Summaries take a while on a small model; this bounds one. */
  summaryTimeoutMs?: number;
}

const SUMMARY_TIMEOUT_MS = 30 * 60_000;

export class MeetingService {
  private recording: { meeting: Meeting; live: LiveTranscript } | null = null;
  private stopping: Promise<void> | null = null;
  /** Meetings being finished, so a second Try again waits for the first. */
  private readonly working = new Set<string>();
  /** Meetings in memory while recorded or finished: a rename must reach these, or their next save undoes it. */
  private readonly held = new Map<string, Meeting>();

  constructor(private readonly opts: MeetingServiceOptions) {}

  status(): MeetingStatus {
    const r = this.recording;
    return {
      recording: r ? { id: r.meeting.id, startedAt: r.meeting.startedAt, lines: r.meeting.lines, pending: r.live.pending } : null,
      blocked: this.opts.blocked(),
    };
  }

  /** A meeting is being worked on after recording (transcript, summary): the chat model may be needed until the pass is done, so it must not be unloaded under it. */
  get summarising(): boolean {
    return this.working.size > 0;
  }

  async start(microphone?: string): Promise<Meeting> {
    if (this.recording || this.stopping) throw new Error("already");
    const blocked = this.opts.blocked();
    if (blocked) throw new Error(blocked);
    const { store } = this.opts;
    const meeting = store.create();
    this.held.set(meeting.id, meeting);
    const live = new LiveTranscript({
      dir: store.folder(meeting.id),
      transcribe: this.opts.transcribe,
      onLine: (line) => this.add(meeting, line),
    });
    this.recording = { meeting, live };
    try {
      await this.opts.recorder.start(store.folder(meeting.id), microphone);
    } catch (err) {
      this.recording = null;
      this.held.delete(meeting.id);
      this.opts.recorder.dispose();
      // Nothing was recorded: the folder holds only the empty meeting.json.
      rmSync(store.folder(meeting.id), { recursive: true, force: true });
      this.changed();
      throw err;
    }
    live.start();
    this.changed();
    return meeting;
  }

  /** Ends the recording; the transcript and summary follow. Resolves when the meeting is finished. */
  stop(spec: string | null): Promise<void> {
    if (this.stopping) return this.stopping;
    const current = this.recording;
    if (!current) return Promise.resolve();
    this.stopping = (async () => {
      try {
        await this.stopAndFinish(current, spec);
      } finally {
        this.held.delete(current.meeting.id);
      }
    })();
    return this.stopping;
  }

  private async stopAndFinish(current: { meeting: Meeting; live: LiveTranscript }, spec: string | null): Promise<void> {
    await this.opts.recorder.stop().catch(() => {});
    // The microphone is let go of now, not when Vunemi quits.
    this.opts.recorder.dispose();
    const { meeting, live } = current;
    meeting.endedAt = Date.now();
    meeting.state = "transcribing";
    this.opts.store.save(meeting);
    this.changed();
    try {
      await live.finish();
    } finally {
      this.recording = null;
      this.stopping = null;
    }
    meeting.language = live.language;
    this.opts.store.save(meeting);
    this.changed();
    if (live.failedSegments > 0) {
      meeting.state = "failed";
      meeting.error = "transcription";
      this.opts.store.save(meeting);
      this.changed();
      return;
    }
    await this.finish(meeting, spec);
  }

  /** The user's name for a meeting, whether it is on disk or still being worked on. */
  rename(id: string, title: string): void {
    const name = title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!name) return;
    const meeting = this.held.get(id) ?? this.opts.store.get(id);
    if (!meeting) return;
    meeting.title = name;
    this.opts.store.save(meeting);
    this.changed();
  }

  /** The recorder ended on its own mid-meeting: keep what it wrote and finish. */
  recorderExited(spec: string | null): void {
    if (this.recording && !this.stopping) void this.stop(spec);
  }

  /** A failed meeting again: its transcript if it has one, else from its audio. */
  async retry(id: string, spec: string | null): Promise<void> {
    if (this.working.has(id) || this.recording?.meeting.id === id) return;
    const meeting = this.opts.store.get(id);
    if (!meeting || meeting.state !== "failed") return;
    this.held.set(id, meeting);
    try {
      if (meeting.lines.length === 0 || meeting.error === "transcription") {
        await this.transcribeAgain(meeting);
        if (meeting.state === "failed") return;
      }
      await this.finish(meeting, spec);
    } finally {
      this.held.delete(id);
    }
  }

  /** At launch: meetings Vunemi quit during, finished from what they wrote. */
  async recover(spec: string | null): Promise<void> {
    for (const meeting of this.opts.store.unfinished()) {
      if (this.working.has(meeting.id) || this.recording?.meeting.id === meeting.id) continue;
      meeting.endedAt ??= Date.now();
      this.held.set(meeting.id, meeting);
      try {
        // Lines written before the quit are written again, all in order.
        await this.transcribeAgain(meeting);
        if (meeting.state !== "failed") await this.finish(meeting, spec);
      } finally {
        this.held.delete(meeting.id);
      }
    }
  }

  async levels(): Promise<Levels> {
    if (!this.recording || this.stopping) return { me: 0, others: 0 };
    return this.opts.recorder.levels().catch(() => ({ me: 0, others: 0 }));
  }

  /** At quit: the recorder stops and keeps its files; the next launch finishes the meeting. */
  dispose(): void {
    this.opts.recorder.dispose();
  }

  // -- internals -------------------------------------------------------------

  private add(meeting: Meeting, line: Line): void {
    meeting.lines.push(line);
    meeting.lines.sort((a, b) => a.start - b.start);
    this.opts.store.save(meeting);
    this.opts.onLine(meeting.id, line);
  }

  private async transcribeAgain(meeting: Meeting): Promise<void> {
    meeting.lines = [];
    meeting.state = "transcribing";
    this.opts.store.save(meeting);
    this.changed();
    const live = new LiveTranscript({
      dir: this.opts.store.folder(meeting.id),
      transcribe: this.opts.transcribe,
      onLine: (line) => this.add(meeting, line),
      language: (meeting.language as Locale | null) ?? null,
    });
    await live.finish();
    meeting.language = live.language;
    if (live.failedSegments > 0) {
      meeting.state = "failed";
      meeting.error = "transcription";
    } else {
      delete meeting.error;
    }
    this.opts.store.save(meeting);
  }

  private async finish(meeting: Meeting, spec: string | null): Promise<void> {
    const { store } = this.opts;
    this.working.add(meeting.id);
    try {
      if (meeting.lines.length === 0) {
        // Nothing was said; there is nothing to summarise, and no audio worth keeping.
        meeting.state = "done";
        meeting.summary = null;
        delete meeting.error;
        store.save(meeting);
        await store.dropAudio(meeting.id);
        return;
      }
      if (!spec) throw new Error("model");
      meeting.state = "summarising";
      delete meeting.error;
      store.save(meeting);
      this.changed();
      const { model, window } = await this.opts.model(spec);
      const words = this.opts.words((meeting.language as Locale | null) ?? null);
      const out = await summarise({
        model,
        lines: meeting.lines,
        window,
        language: words.language,
        names: words.names,
        headings: words.headings,
        signal: AbortSignal.timeout(this.opts.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS),
      });
      meeting.summary = out.markdown;
      if (!meeting.title && out.title) meeting.title = out.title;
      meeting.state = "done";
      store.save(meeting);
      await store.dropAudio(meeting.id);
    } catch (err) {
      meeting.state = "failed";
      meeting.error = err instanceof Error ? err.message : String(err);
      store.save(meeting);
    } finally {
      this.working.delete(meeting.id);
      this.changed();
    }
  }

  private changed(): void {
    this.opts.onChange(this.status());
  }
}
