/**
 * Telling the others apart: reading what the program prints, giving lines
 * their speaker, and the corrections' small parts. The program itself and
 * the downloads are stand-ins here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Line } from "../../src/main/meetings/live.js";
import { RATE } from "../../src/main/meetings/segmenter.js";
import {
  assignSpeakers,
  parseTurns,
  renameIn,
  SEGMENTATION_MODEL,
  SpeakerSeparator,
  speakerName,
  speakersBinary,
  speakersLeft,
  SPEAKERS_TAG,
  SPEAKERS_WAV,
  VOICE_MODEL,
  wavFromPcm,
} from "../../src/main/meetings/speakers.js";
import type { SpeakersStatus } from "../../src/shared/ipc.js";

const others = (start: number, end: number, text = "x"): Line => ({ source: "others", start, end, text });
const BYTES = SEGMENTATION_MODEL.size + VOICE_MODEL.size;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vunemi-speakers-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseTurns", () => {
  it("reads the turns from among the program's other lines", () => {
    const out = [
      "OfflineSpeakerDiarizationConfig(segmentation=...)",
      "Started",
      "progress 12.50%",
      "0.318 -- 6.865 speaker_00",
      "7.017 -- 10.747 speaker_01",
      " 11 -- 12.5 speaker_10 ",
      "5.000 -- 5.000 speaker_00",
      "Duration : 56.861 s",
      "Elapsed seconds: 4.731 s",
    ].join("\n");
    expect(parseTurns(out)).toEqual([
      { start: 0.318, end: 6.865, voice: 0 },
      { start: 7.017, end: 10.747, voice: 1 },
      { start: 11, end: 12.5, voice: 10 },
    ]);
  });

  it("finds none in an answer without any", () => {
    expect(parseTurns("Started\nElapsed seconds: 1 s\n")).toEqual([]);
  });
});

describe("assignSpeakers", () => {
  it("numbers the voices in the order they first speak, and leaves the user's lines alone", () => {
    const lines: Line[] = [{ source: "me", start: 0, end: 2, text: "me" }, others(2, 5), others(6, 9), others(10, 12)];
    const turns = [
      { start: 2, end: 5, voice: 3 },
      { start: 6, end: 9, voice: 0 },
      { start: 10, end: 12, voice: 3 },
    ];
    const told = assignSpeakers(lines, turns);
    expect(told.lines.map((l) => l.speaker)).toEqual([undefined, 1, 2, 1]);
    expect(told.speakers).toEqual([{ id: 1, name: "" }, { id: 2, name: "" }]);
    expect(lines.every((l) => l.speaker === undefined)).toBe(true);
  });

  it("gives a line two people share to the one who spoke more of it", () => {
    const told = assignSpeakers(
      [others(0, 5), others(10, 20)],
      [
        { start: 0, end: 5, voice: 0 },
        // In the second line: voice 0 for four seconds in two stretches, voice 1 for six.
        { start: 10, end: 12, voice: 0 },
        { start: 12, end: 15, voice: 1 },
        { start: 15, end: 17, voice: 0 },
        { start: 17, end: 20, voice: 1 },
      ],
    );
    expect(told.lines.map((l) => l.speaker)).toEqual([1, 2]);
  });

  it("lets a line no voice was heard in take the one next to it, when that is near", () => {
    const turns = [{ start: 0, end: 5, voice: 0 }, { start: 20, end: 25, voice: 1 }];
    const told = assignSpeakers([others(0, 5), others(5.5, 6.5), others(10, 11), others(18.5, 19.5), others(20, 25)], turns);
    expect(told.lines.map((l) => l.speaker)).toEqual([1, 1, undefined, 2, 2]);
  });

  it("starts over on lines that already had a speaker", () => {
    const told = assignSpeakers([{ ...others(0, 5), speaker: 7 }, { ...others(30, 31), speaker: 7 }], [{ start: 0, end: 5, voice: 2 }]);
    expect(told.lines).toEqual([{ ...others(0, 5), speaker: 1 }, others(30, 31)]);
  });

  it("tells no one apart without turns", () => {
    expect(assignSpeakers([others(0, 5)], [])).toEqual({ lines: [others(0, 5)], speakers: [] });
  });
});

describe("the corrections' parts", () => {
  it("tidies a name", () => {
    expect(speakerName("  Deniz \n  Kaya ")).toBe("Deniz Kaya");
    expect(speakerName("   ")).toBe("");
    expect(speakerName("a".repeat(100))).toHaveLength(60);
  });

  it("keeps the speakers that still have a line", () => {
    const speakers = [{ id: 1, name: "A" }, { id: 2, name: "" }, { id: 3, name: "C" }];
    expect(speakersLeft([{ ...others(0, 1), speaker: 3 }, others(2, 3), { ...others(4, 5), speaker: 1 }], speakers)).toEqual([speakers[0], speakers[2]]);
  });

  it("renames a person where the words stand as a name", () => {
    expect(renameIn("Kişi 1 geldi. Kişi 12 gelmedi; Kişi 1'in notu, (Kişi 1).", "Kişi 1", "Deniz")).toBe("Deniz geldi. Kişi 12 gelmedi; Deniz'in notu, (Deniz).");
    expect(renameIn("Ann and Annabel, Joann.", "Ann", "Bo")).toBe("Bo and Annabel, Joann.");
    expect(renameIn("A. B (x) said so.", "A. B (x)", "$1 & $&")).toBe("$1 & $& said so.");
    expect(renameIn("same", "", "x")).toBe("same");
  });
});

describe("wavFromPcm", () => {
  it("puts a header for 16 kHz mono 16-bit in front of the samples", async () => {
    const pcm = join(root, "system.pcm");
    const wav = join(root, "out.wav");
    // An odd byte at the end is half a sample the recorder was still writing.
    writeFileSync(pcm, Buffer.from([1, 2, 3, 4, 5, 6, 7]));
    await wavFromPcm(pcm, wav);
    const out = readFileSync(wav);
    expect(out.length).toBe(44 + 6);
    expect(out.toString("latin1", 0, 4)).toBe("RIFF");
    expect(out.readUInt32LE(4)).toBe(36 + 6);
    expect(out.toString("latin1", 8, 16)).toBe("WAVEfmt ");
    expect([out.readUInt16LE(20), out.readUInt16LE(22), out.readUInt32LE(24), out.readUInt32LE(28), out.readUInt16LE(32), out.readUInt16LE(34)]).toEqual([1, 1, RATE, RATE * 2, 2, 16]);
    expect(out.toString("latin1", 36, 40)).toBe("data");
    expect(out.readUInt32LE(40)).toBe(6);
    expect([...out.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("writes an empty one for no audio", async () => {
    const pcm = join(root, "system.pcm");
    writeFileSync(pcm, Buffer.alloc(0));
    await wavFromPcm(pcm, join(root, "out.wav"));
    expect(readFileSync(join(root, "out.wav")).length).toBe(44);
  });
});

describe("speakersBinary", () => {
  it("is the one in the app's resources when installed, and the build cache's or the named one in development", () => {
    const resources = join(root, "Resources");
    const cache = join(root, ".vunemi-build", "speakers-cache", SPEAKERS_TAG);
    mkdirSync(resources);
    mkdirSync(cache, { recursive: true });
    const name = "sherpa-onnx-offline-speaker-diarization";
    expect(speakersBinary({ packaged: true, resourcesPath: resources, home: root })).toBeNull();
    expect(speakersBinary({ packaged: false, resourcesPath: resources, home: root })).toBeNull();
    writeFileSync(join(resources, name), "");
    writeFileSync(join(cache, name), "");
    writeFileSync(join(root, "mine"), "");
    expect(speakersBinary({ packaged: true, resourcesPath: resources, home: root, env: { VUNEMI_SPEAKERS_BINARY: join(root, "mine") } })).toBe(join(resources, name));
    expect(speakersBinary({ packaged: false, resourcesPath: resources, home: root })).toBe(join(cache, name));
    expect(speakersBinary({ packaged: false, resourcesPath: resources, home: root, env: { VUNEMI_SPEAKERS_BINARY: join(root, "mine") } })).toBe(join(root, "mine"));
    expect(speakersBinary({ packaged: false, resourcesPath: resources, home: root, env: { VUNEMI_SPEAKERS_BINARY: join(root, "gone") } })).toBeNull();
  });
});

describe("SpeakerSeparator", () => {
  const models = () => join(root, "models");
  const place = (): void => {
    mkdirSync(models(), { recursive: true });
    writeFileSync(join(models(), "pyannote-segmentation-3.0.onnx"), "s");
    writeFileSync(join(models(), VOICE_MODEL.file), "v");
  };
  const meeting = (seconds = 1): string => {
    const folder = join(root, "meeting");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "system.pcm"), Buffer.alloc(seconds * RATE * 2));
    return folder;
  };

  it("cannot be used in a build without the program", async () => {
    place();
    const separator = new SpeakerSeparator({ binary: null, dir: models() });
    expect(separator.ready()).toBe(false);
    expect(separator.status()).toEqual({ state: "unavailable" });
    expect(await separator.download()).toEqual({ state: "unavailable" });
    await expect(separator.separate(meeting())).rejects.toThrow("not ready");
  });

  it("downloads the two pinned files, the first under its own name, and tells how far it is", async () => {
    const seen: SpeakersStatus[] = [];
    const asked: { file: string; saveAs: string | undefined }[] = [];
    const separator = new SpeakerSeparator({
      binary: "/bin/program",
      dir: models(),
      onChange: (s) => seen.push(s),
      download: async (src, dir, opts) => {
        asked.push({ file: src.file, saveAs: opts.saveAs });
        opts.onProgress?.({ received: 100, total: src.size, bytesPerSecond: 1 });
        mkdirSync(dir, { recursive: true });
        const path = join(dir, opts.saveAs ?? src.file);
        writeFileSync(path, "x");
        return path;
      },
    });
    expect(separator.status()).toEqual({ state: "absent", bytes: BYTES });
    expect(await separator.download()).toEqual({ state: "ready", bytes: BYTES });
    expect(asked).toEqual([
      { file: SEGMENTATION_MODEL.file, saveAs: "pyannote-segmentation-3.0.onnx" },
      { file: VOICE_MODEL.file, saveAs: undefined },
    ]);
    expect(seen).toContainEqual({ state: "downloading", bytes: BYTES, received: 100 });
    expect(seen).toContainEqual({ state: "downloading", bytes: BYTES, received: SEGMENTATION_MODEL.size + 100 });
    expect(seen.at(-1)).toEqual({ state: "ready", bytes: BYTES });
    expect(separator.ready()).toBe(true);
  });

  it("is absent again after a download that failed or was cancelled", async () => {
    let signal: AbortSignal | undefined;
    const separator = new SpeakerSeparator({
      binary: "/bin/program",
      dir: models(),
      download: (_src, _dir, opts) =>
        new Promise((_resolve, reject) => {
          signal = opts.signal;
          opts.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const first = separator.download();
    const second = separator.download();
    expect(separator.status()).toEqual({ state: "downloading", bytes: BYTES, received: 0 });
    separator.cancelDownload();
    await expect(first).rejects.toThrow("cancelled");
    await expect(second).rejects.toThrow("cancelled");
    expect(signal?.aborted).toBe(true);
    expect(separator.status()).toEqual({ state: "absent", bytes: BYTES });
  });

  it("hands the program a copy of the others' audio, reads its turns, and removes the copy", async () => {
    place();
    const folder = meeting();
    let ran: { binary: string; args: string[]; wavBytes: number } | null = null;
    const separator = new SpeakerSeparator({
      binary: "/bin/program",
      dir: models(),
      run: async (binary, args) => {
        ran = { binary, args, wavBytes: readFileSync(args.at(-1)!).length };
        return "Started\n0.000 -- 0.500 speaker_00\n0.500 -- 1.000 speaker_01\n";
      },
    });
    expect(await separator.separate(folder)).toEqual([
      { start: 0, end: 0.5, voice: 0 },
      { start: 0.5, end: 1, voice: 1 },
    ]);
    expect(ran!.binary).toBe("/bin/program");
    // The audio is the last argument: the program reads nothing after it.
    expect(ran!.args.at(-1)).toBe(join(folder, SPEAKERS_WAV));
    expect(ran!.args).toContain(`--segmentation.pyannote-model=${join(models(), "pyannote-segmentation-3.0.onnx")}`);
    expect(ran!.args).toContain(`--embedding.model=${join(models(), VOICE_MODEL.file)}`);
    expect(ran!.args).toContain("--clustering.cluster-threshold=0.65");
    expect(ran!.wavBytes).toBe(44 + RATE * 2);
    expect(existsSync(join(folder, SPEAKERS_WAV))).toBe(false);
    expect(existsSync(join(folder, "system.pcm"))).toBe(true);
  });

  it("removes the copy when the program fails too, and cannot say without the others' audio", async () => {
    place();
    const folder = meeting();
    const separator = new SpeakerSeparator({
      binary: "/bin/program",
      dir: models(),
      run: async () => {
        throw new Error("ended with 1");
      },
    });
    await expect(separator.separate(folder)).rejects.toThrow("ended with 1");
    expect(existsSync(join(folder, SPEAKERS_WAV))).toBe(false);
    rmSync(join(folder, "system.pcm"));
    await expect(separator.separate(folder)).rejects.toThrow("not ready");
  });
});
