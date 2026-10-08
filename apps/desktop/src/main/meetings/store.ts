/**
 * Meetings, kept on this Mac: one folder each under userData/meetings, with
 * meeting.json (transcript, summary, state) and, until the summary is done,
 * the recorder's two PCM files. Owner-only, like conversations.
 *
 * Nothing is ever deleted outright: audio and whole meetings go to the Trash.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Line } from "./live.js";

export type MeetingState = "recording" | "transcribing" | "summarising" | "done" | "failed";

export interface Meeting {
  id: string;
  /** Empty until named: the window shows the date in its own language. */
  title: string;
  startedAt: number;
  endedAt: number | null;
  language: string | null;
  lines: Line[];
  /** Markdown, in the fixed template. */
  summary: string | null;
  state: MeetingState;
  error?: string;
}

export type MeetingSummary = Omit<Meeting, "lines">;

/** A meeting's id, and its folder's name. */
export const MEETING_ID = /^[0-9a-f-]{36}$/;
const AUDIO = ["mic.pcm", "system.pcm"];

export class MeetingStore {
  constructor(
    private readonly dir: string,
    private readonly trash: (path: string) => Promise<void>,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  create(): Meeting {
    const meeting: Meeting = { id: randomUUID(), title: "", startedAt: Date.now(), endedAt: null, language: null, lines: [], summary: null, state: "recording" };
    mkdirSync(this.folder(meeting.id), { mode: 0o700 });
    this.save(meeting);
    return meeting;
  }

  /** The meeting's folder. Refuses anything that is not one of our ids. */
  folder(id: string): string {
    if (!MEETING_ID.test(id)) throw new Error("bad meeting id");
    return join(this.dir, id);
  }

  get(id: string): Meeting | null {
    try {
      return JSON.parse(readFileSync(join(this.folder(id), "meeting.json"), "utf8")) as Meeting;
    } catch {
      return null;
    }
  }

  list(): MeetingSummary[] {
    return this.all()
      .map(({ lines: _lines, ...summary }) => summary)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  save(meeting: Meeting): void {
    const file = join(this.folder(meeting.id), "meeting.json");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(meeting), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  /** Ids of the meetings whose title, summary or words contain every word of `q`. */
  search(q: string): string[] {
    const words = q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.list().map((m) => m.id);
    return this.all()
      .filter((m) => {
        const text = [m.title, m.summary ?? "", ...m.lines.map((l) => l.text)].join("\n").toLocaleLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((m) => m.id);
  }

  /** Meetings Vunemi stopped in the middle of, at quit or in a crash. */
  unfinished(): Meeting[] {
    return this.all().filter((m) => m.state === "recording" || m.state === "transcribing" || m.state === "summarising");
  }

  async dropAudio(id: string): Promise<void> {
    for (const name of AUDIO) {
      const path = join(this.folder(id), name);
      if (existsSync(path)) await this.trash(path);
    }
  }

  async remove(id: string): Promise<void> {
    const folder = this.folder(id);
    if (existsSync(folder)) await this.trash(folder);
  }

  private all(): Meeting[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.filter((n) => MEETING_ID.test(n)).flatMap((n) => this.get(n) ?? []);
  }
}
