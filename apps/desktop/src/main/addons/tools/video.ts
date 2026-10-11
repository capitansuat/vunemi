/**
 * Video editing, through FilmCraft: a new video cut together from clips the
 * user has, with titles, captions and music. The model describes the edit
 * in seconds; the steps the program runs are written here.
 *
 * An export can take minutes. The run's own stop is the way out: stopping
 * the task stops the program.
 */

import { copyFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { EngineJob } from "../jobs.js";
import type { SandboxResult } from "../sandbox.js";
import { deliver, expectFile, said, short, show, source, target, text, type AddonToolDeps } from "./common.js";

const ENGINE = "FilmCraft";
/** The program counts time in these: 254,016,000,000 to a second. */
const TICKS = 254_016_000_000;
const VIDEOS = [".mp4", ".mov", ".m4v"] as const;
const SOUNDS = [".mp3", ".m4a", ".wav", ".aac", ".aiff"] as const;
const MAX_CLIPS = 40;
const MAX_TEXTS = 200;
const MAX_SECONDS = 30 * 60;
const EXPORT_MS = 40 * 60_000;
const STEP_MS = 180_000;
/** How far music is turned down under the clips' own sound. */
const MUSIC_DB = -12;

export const VIDEO_GUIDE = `Editing video:
- video_info says how long a video is, its size and whether it has sound. Call it before cutting, so start and end fall inside the clip.
- video_make cuts clips together in the order given into a new .mp4. start and end trim a clip, in seconds of that clip. Titles and captions are placed at seconds of the finished video; captions are drawn into the picture. music is an audio file played quietly under the whole video.
- It can take a few minutes; say so before calling it. It cannot generate footage, and the originals are never changed. The user is shown a frame of the result.`;

interface Probe {
  seconds: number;
  width: number;
  height: number;
  fps: number;
  sound: boolean;
}

function fail(result: SandboxResult): never {
  throw new Error(t("apps.error.failed", { app: ENGINE, detail: said(result) }));
}

async function probe(job: EngineJob, file: string): Promise<Probe> {
  const result = await job.run(["probe", file]);
  try {
    const info = JSON.parse(result.stdout) as { duration?: number; audio_streams?: unknown[]; video?: { width?: number; height?: number; frame_rate?: { num?: number; den?: number } } };
    const rate = info.video?.frame_rate;
    return {
      seconds: (info.duration ?? 0) / TICKS,
      width: info.video?.width ?? 0,
      height: info.video?.height ?? 0,
      fps: rate?.num && rate.den ? rate.num / rate.den : 0,
      sound: (info.audio_streams ?? []).length > 0,
    };
  } catch {
    return fail(result);
  }
}

interface Step {
  id: string;
  params: Record<string, unknown>;
}

/** Runs commands on the project and returns what each answered. Any refusal ends the edit. */
async function steps(job: EngineJob, first: boolean, list: Step[]): Promise<unknown[]> {
  if (list.length === 0) return [];
  const args = [...(first ? ["--save-as", "edit.fcproj"] : ["--project", "edit.fcproj", "--save"]), "--compact", "run", "-"];
  const result = await job.run(args, { stdin: list.map((step) => JSON.stringify(step)).join("\n") + "\n", timeoutMs: STEP_MS });
  const answers = result.stdout.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try {
      return [JSON.parse(line) as { ok?: boolean; error?: unknown; result?: unknown }];
    } catch {
      return [];
    }
  });
  const refused = answers.find((answer) => answer.ok === false || ((answer.result as { errors?: unknown[] } | null)?.errors ?? []).length > 0);
  if (result.code !== 0 || refused || answers.length < list.length) {
    const why = refused ? JSON.stringify(refused.error ?? (refused.result as { errors?: unknown }).errors).slice(0, 300) : said(result);
    throw new Error(t("apps.error.failed", { app: ENGINE, detail: why }));
  }
  return answers.map((answer) => answer.result);
}

interface Sequence {
  duration: number;
  video: { items: { clip: number }[] }[];
  audio: { items: { clip: number }[] }[];
}

async function sequence(job: EngineJob): Promise<Sequence> {
  const result = await job.run(["--project", "edit.fcproj", "inspect", "sequence"]);
  try {
    return JSON.parse(result.stdout) as Sequence;
  } catch {
    return fail(result);
  }
}

interface Timed {
  text: string;
  at: number;
  seconds: number;
}

/** Titles or captions, kept inside the finished video: one past its end would lengthen it. */
export function timed(input: unknown, total: number, fallback: number): Timed[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("titles and captions are lists of { text, at, seconds }.");
  return input.slice(0, MAX_TEXTS).flatMap((raw) => {
    const one = (raw ?? {}) as { text?: unknown; at?: unknown; seconds?: unknown };
    const words = text(one.text, 300).trim();
    const at = Math.max(0, Number(one.at) || 0);
    if (!words || at >= total) return [];
    const seconds = Math.min(Math.max(0.5, Number(one.seconds) || fallback), total - at);
    return [{ text: words, at, seconds }];
  });
}

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

export function videoTools(deps: AddonToolDeps): ToolDef[] {
  const words = { type: "array", items: { type: "object", properties: { text: { type: "string" }, at: { type: "number" }, seconds: { type: "number" } }, required: ["text", "at"] } };
  return [
    {
      name: "video_info",
      description: "How long a video is, in seconds, its frame size and whether it has sound.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      actionClass: "read",
      preview: async (a) => t("files.preview.read", { path: short(String(a.path ?? "")) }),
      async run(a, ctx) {
        const from = source(deps.roots, a.path, VIDEOS);
        return deps.engines("video", ctx.signal, async (job) => {
          const name = `in${extname(from).toLowerCase()}`;
          copyFileSync(from, join(job.dir, name));
          const info = await probe(job, name);
          return `${short(from)}: ${info.seconds.toFixed(1)} seconds, ${info.width} by ${info.height}, ${info.fps.toFixed(2)} frames a second, ${info.sound ? "with sound" : "no sound"}.`;
        });
      },
    },
    {
      name: "video_make",
      description: "Make a new video (.mp4) from clips in order. start and end trim a clip, in seconds. Titles and captions go at seconds of the finished video.",
      parameters: {
        type: "object",
        properties: {
          out: { type: "string", description: "Ends in .mp4" },
          clips: { type: "array", items: { type: "object", properties: { path: { type: "string" }, start: { type: "number" }, end: { type: "number" } }, required: ["path"] } },
          fade: { type: "boolean", description: "Cross-fade between clips" },
          titles: words,
          captions: words,
          music: { type: "string", description: "An audio file to play under the video" },
        },
        required: ["out", "clips"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.out ?? "")) }),
      async run(a, ctx) {
        const out = target(deps.roots, a.out, [".mp4"]);
        if (!Array.isArray(a.clips) || a.clips.length === 0) throw new Error("clips must list at least one video.");
        if (a.clips.length > MAX_CLIPS) throw new Error(`At most ${MAX_CLIPS} clips.`);
        const asked = (a.clips as { path?: unknown; start?: unknown; end?: unknown }[]).map((clip) => ({ from: source(deps.roots, clip?.path, VIDEOS), start: Number(clip?.start) || 0, end: Number(clip?.end) || 0 }));
        const music = String(a.music ?? "").trim() ? source(deps.roots, a.music, SOUNDS) : null;

        return deps.engines("video", ctx.signal, async (job) => {
          // Each different file once, under a plain name.
          const names = new Map<string, string>();
          for (const { from } of asked) {
            if (names.has(from)) continue;
            names.set(from, `clip-${names.size + 1}${extname(from).toLowerCase()}`);
            copyFileSync(from, join(job.dir, names.get(from)!));
          }
          const probes = new Map<string, Probe>();
          for (const name of names.values()) probes.set(name, await probe(job, name));
          const cuts = asked.map(({ from, start, end }, index) => {
            const name = names.get(from)!;
            const length = probes.get(name)!.seconds;
            const begin = Math.max(0, start);
            const stop = end > 0 ? Math.min(end, length) : length;
            if (stop - begin < 0.1) throw new Error(`Clip ${index + 1} (${short(from)}) is ${length.toFixed(1)} seconds long; ${begin} to ${end || length.toFixed(1)} leaves nothing.`);
            return { name, begin, seconds: stop - begin };
          });
          const total = cuts.reduce((sum, cut) => sum + cut.seconds, 0);
          if (total > MAX_SECONDS) throw new Error(`The video would be ${clock(total)} long; at most ${clock(MAX_SECONDS)}.`);
          const frame = probes.get(cuts[0]!.name)!;
          if (!frame.width || !frame.height) throw new Error(`${short(asked[0]!.from)} has no picture.`);
          const musicName = music ? `music${extname(music).toLowerCase()}` : null;
          if (music && musicName) copyFileSync(music, join(job.dir, musicName));

          const files = [...names.values(), ...(musicName ? [musicName] : [])];
          const [imported] = await steps(job, true, [
            { id: "file.import", params: { paths: files } },
            { id: "file.newSequence", params: { name: "Vunemi", width: frame.width, height: frame.height, fps: frame.fps || 30 } },
          ]);
          const ids = (imported as { items?: number[] } | null)?.items ?? [];
          if (ids.length !== files.length) throw new Error(t("apps.error.failed", { app: ENGINE, detail: "not every file could be imported" }));
          const item = new Map(files.map((name, index) => [name, ids[index]!]));

          let at = 0;
          const place: Step[] = cuts.map((cut) => {
            const step = { id: "timeline.place", params: { item: item.get(cut.name), track: "V1", seconds: at, insert: false, sourceIn: Math.round(cut.begin * TICKS), duration: Math.round(cut.seconds * TICKS) } };
            at += cut.seconds;
            return step;
          });
          if (musicName) place.push({ id: "timeline.place", params: { item: item.get(musicName), track: "A2", seconds: 0, insert: false, duration: Math.round(total * TICKS) } });
          await steps(job, false, place);

          const laid = await sequence(job);
          const picture = (laid.video[0]?.items ?? []).map((entry) => entry.clip);
          const dress: Step[] = [];
          if (a.fade === true) for (const clip of picture.slice(1)) dress.push({ id: "sequence.applyVideoTransition", params: { clip, effect: "cross_dissolve", frames: 12, edge: "in" } });
          const under = musicName ? (laid.audio[1]?.items ?? []).map((entry) => entry.clip) : [];
          if (under.length > 0) dress.push({ id: "clip.audioGain", params: { clips: under, mode: "adjust", db: MUSIC_DB } });
          const titles = timed(a.titles, total, 3);
          for (const title of titles) {
            dress.push({ id: "graphics.newText", params: { text: title.text, position: [Math.round(frame.width * 0.06), Math.round(frame.height * 0.2)], size: Math.round(frame.height * 0.1), newClip: true, seconds: title.seconds, time: Math.round(title.at * TICKS) } });
          }
          const captions = timed(a.captions, total, 2.5);
          if (captions.length > 0) dress.push({ id: "captions.newTrack", params: { format: "Subtitle" } });
          for (const caption of captions) dress.push({ id: "captions.add", params: { text: caption.text, seconds: caption.at, durationSeconds: caption.seconds } });
          await steps(job, false, dress);

          const exported = await job.run(["--project", "edit.fcproj", "export", "out.mp4", "--format", "h264", ...(captions.length > 0 ? ["--settings", JSON.stringify({ burnCaptions: true })] : [])], { timeoutMs: EXPORT_MS });
          expectFile(ENGINE, exported, join(job.dir, "out.mp4"));
          const done = await probe(job, "out.mp4");
          await job.run(["--project", "edit.fcproj", "render", "--seconds", String(Math.min(1, done.seconds / 2)), "--out", "frame.png", "--scale", String(Math.min(1, 900 / frame.width))]);
          deliver(join(job.dir, "out.mp4"), out, ctx);
          show(deps, join(job.dir, "frame.png"), short(out), ctx);
          const extras = [titles.length ? `${titles.length} ${titles.length === 1 ? "title" : "titles"}` : "", captions.length ? `${captions.length} ${captions.length === 1 ? "caption" : "captions"}` : "", musicName ? "music" : "", a.fade === true && cuts.length > 1 ? "cross-fades" : ""].filter(Boolean);
          return `Created ${short(out)}: ${done.seconds.toFixed(1)} seconds, ${done.width} by ${done.height}, from ${cuts.length} ${cuts.length === 1 ? "clip" : "clips"}${extras.length ? `, with ${extras.join(", ")}` : ""}. The user is shown a frame of it.`;
        });
      },
    },
  ];
}
