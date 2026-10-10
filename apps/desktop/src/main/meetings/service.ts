/**
 * A meeting from the Record button to its summary. Recording starts only
 * from the user's button (IPC from the window); no tool and no automation
 * reaches this.
 *
 *   recording → transcribing (whisper catches up) → separating → summarising → done
 *                                                                            ↘ failed
 *
 * Separating (telling the others apart, speakers.ts) is skipped unless the
 * user switched it on.
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
import { assignSpeakers, renameIn, speakerName, speakersLeft, type Turn } from "./speakers.js";
import type { Meeting, MeetingStore } from "./store.js";
import { speakerLabel, summarise, type Headings, type Names } from "./summary.js";

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
  /** Telling the others apart, when this build can and the user switched it on (speakers.ts). */
  speakers?: { ready: () => boolean; turns: (folder: string) => Promise<Turn[]> };
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

  /** A meeting is being recorded; cheaper than status(), which also asks why it could not be. */
  get isRecording(): boolean {
    return this.recording !== null;
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

  /**
   * The user's name for one of the others; an empty one, or the number
   * typed back, gives the number back. The summary calls them the same from
   * then on.
   */
  nameSpeaker(id: string, speaker: number, raw: string): void {
    this.correct(id, (meeting, call) => {
      const who = meeting.speakers?.find((s) => s.id === speaker);
      if (!who) return;
      const was = call(speaker);
      const name = speakerName(raw);
      who.name = "";
      if (name !== call(speaker)) who.name = name;
      if (meeting.summary) meeting.summary = renameIn(meeting.summary, was, call(speaker));
    });
  }

  /** Two of the others that are one person: `from`'s lines become `into`'s. */
  mergeSpeakers(id: string, from: number, into: number): void {
    this.correct(id, (meeting, call) => {
      const speakers = meeting.speakers ?? [];
      if (from === into || !speakers.some((s) => s.id === from) || !speakers.some((s) => s.id === into)) return;
      if (meeting.summary) meeting.summary = renameIn(meeting.summary, call(from), call(into));
      for (const line of meeting.lines) if (line.speaker === from) line.speaker = into;
      meeting.speakers = speakers.filter((s) => s.id !== from);
    });
  }

  /** One line that was given to the wrong person. The summary is left as it is: what it says of the line cannot be told from here. */
  moveLine(id: string, start: number, speaker: number): void {
    this.correct(id, (meeting) => {
      const line = meeting.lines.find((l) => l.source === "others" && l.start === start);
      if (!line || !meeting.speakers?.some((s) => s.id === speaker)) return;
      line.speaker = speaker;
      meeting.speakers = speakersLeft(meeting.lines, meeting.speakers);
    });
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

  /** A change the user makes to who said what, in a meeting that is not being worked on. */
  private correct(id: string, change: (meeting: Meeting, call: (speaker: number) => string) => void): void {
    if (this.working.has(id) || this.recording?.meeting.id === id) return;
    const meeting = this.opts.store.get(id);
    if (!meeting?.speakers) return;
    const { names } = this.opts.words((meeting.language as Locale | null) ?? null);
    change(meeting, (speaker) => speakerLabel(speaker, names, meeting.speakers));
    this.opts.store.save(meeting);
    this.changed();
  }

  /**
   * Tells the others apart, when that is switched on and their audio is
   * still here. Whatever goes wrong, the meeting stays as it was before:
   * the others as one.
   */
  private async separate(meeting: Meeting): Promise<void> {
    const speakers = this.opts.speakers;
    if (!speakers?.ready() || meeting.speakers || !meeting.lines.some((l) => l.source === "others")) return;
    meeting.state = "separating";
    this.opts.store.save(meeting);
    this.changed();
    try {
      const told = assignSpeakers(meeting.lines, await speakers.turns(this.opts.store.folder(meeting.id)));
      meeting.lines = told.lines;
      meeting.speakers = told.speakers;
      this.opts.store.save(meeting);
    } catch (err) {
      console.error("[vunemi] speakers:", err instanceof Error ? err.message : String(err));
    }
  }

  private async transcribeAgain(meeting: Meeting): Promise<void> {
    meeting.lines = [];
    delete meeting.speakers;
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
      await this.separate(meeting);
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
        ...(meeting.speakers?.length && { speakers: meeting.speakers }),
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
