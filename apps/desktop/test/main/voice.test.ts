/**
 * Voice, minus the microphone: what whisper gives back, and which model gets
 * picked. The end-to-end test is real — macOS speaks a sentence and whisper
 * has to read it back — but it loads a 1.5 GB model, so it only runs with
 *
 *   VUNEMI_LIVE_VOICE=1 pnpm --filter @vunemi/desktop test voice
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { clean, findModel, noSpeech, Voice } from "../../src/main/voice.js";

const run = promisify(execFile);

describe("clean", () => {
  it("drops the noises whisper writes for silence", () => {
    expect(clean(" [BLANK_AUDIO]\n Merhaba Vunemi. \n")).toBe("Merhaba Vunemi.");
    expect(clean("(müzik) bugün hava nasıl?")).toBe("bugün hava nasıl?");
  });

  it("returns nothing for the sentences whisper invents over silence", () => {
    expect(clean("İzlediğiniz için teşekkür ederim.")).toBe("");
    expect(clean(" Altyazı M.K. ")).toBe("");
    // But the same words inside a real sentence are the user's.
    expect(clean("Videoyu izlediğiniz için teşekkür ederim, şimdi not al")).toBe(
      "Videoyu izlediğiniz için teşekkür ederim, şimdi not al",
    );
  });

  it("keeps ordinary brackets in speech intact enough to read", () => {
    expect(clean("Toplam 3 (üç) adet")).toBe("Toplam 3 (üç) adet");
  });
});

describe("findModel", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vunemi-voice-"));
    delete process.env.VUNEMI_WHISPER_MODEL;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (...names: string[]) => {
    const models = join(dir, "models");
    rmSync(models, { recursive: true, force: true });
    mkdirSync(models, { recursive: true });
    for (const n of names) writeFileSync(join(models, n), "");
    return models;
  };

  it("prefers the most capable model it finds, not the first alphabetically", () => {
    const models = put("ggml-base.bin", "ggml-large-v3-turbo.bin", "ggml-small.bin");
    expect(findModel(dir)).toBe(join(models, "ggml-large-v3-turbo.bin"));
  });

  it("falls back down the ladder", () => {
    const models = put("ggml-base.bin", "ggml-small.bin");
    expect(findModel(dir)).toBe(join(models, "ggml-small.bin"));
  });

  it("ignores files that aren't models, and looks in the next folder instead", () => {
    const models = put("notes.txt", "ggml-medium.bin.part");
    // Either nothing at all, or a model from one of the shared folders — but
    // never the half-downloaded file sitting right here.
    expect(findModel(dir)?.startsWith(models) ?? false).toBe(false);
  });

  it("lets the user name one outright", () => {
    const file = join(dir, "elsewhere.bin");
    writeFileSync(file, "");
    process.env.VUNEMI_WHISPER_MODEL = file;
    expect(findModel(dir)).toBe(file);
  });
});

const live = process.env.VUNEMI_LIVE_VOICE === "1";

describe.skipIf(!live)("Voice, for real", () => {
  let dir = "";
  let voice: Voice;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vunemi-voice-live-"));
    voice = new Voice(dir);
  });
  afterEach(() => {
    voice.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hears a Turkish sentence macOS says", async () => {
    expect(voice.status().canHear).toBe(true);
    const wav = join(dir, "clip.wav");
    // The same synthesiser Vunemi answers with, so the test needs no fixture.
    await run("/usr/bin/say", ["-v", "Yelda", "--data-format=LEI16@16000", "-o", wav, "--", "Bugün hava nasıl?"]);

    // Live, 27 Sep: with Vunemi set to English, Turkish speech came back as broken English.
    setLocale("en");
    const heard = await voice.transcribe(readFileSync(wav));
    expect(heard.toLocaleLowerCase("tr")).toContain("hava");

    // The second utterance reuses the loaded model, which is the whole point
    // of keeping the sidecar alive.
    const started = Date.now();
    await voice.transcribe(readFileSync(wav));
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 120_000);
});

describe("noSpeech", () => {
  it("weighs whisper's belief by how long each part is", () => {
    expect(noSpeech(undefined)).toBe(0);
    expect(noSpeech([{ start: 0, end: 3, no_speech_prob: 0.1 }, { start: 3, end: 4, no_speech_prob: 0.9 }])).toBeCloseTo(0.3);
    expect(noSpeech([{ t0: 0, t1: 100, no_speech_prob: 0.8 }, { text: "x" } as never])).toBeCloseTo(0.8);
  });
});

describe("the voice as the model manager sees it", () => {
  it("holds nothing and is not busy before it is used", () => {
    const voice = new Voice(mkdtempSync(join(tmpdir(), "vunemi-voice-")));
    expect(voice.pid()).toBeNull();
    expect(voice.busy()).toBe(false);
    voice.unload(); // nothing to stop
    expect(voice.pid()).toBeNull();
  });
});
