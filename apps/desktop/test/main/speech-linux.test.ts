/** Answers read aloud on Linux with the built-in espeak-ng. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { espeakDir, linuxSpeakArgs, linuxVoices, spawnLinuxSpeech } from "../../src/main/speech-linux.js";
import { Voice } from "../../src/main/voice.js";

const linux = process.platform === "linux";
const built = () => {
  const dir = espeakDir({ packaged: false, resourcesPath: "", home: homedir() });
  if (!dir) throw new Error("espeak-ng is not built: build it: scripts/build-espeak-linux.sh");
  return dir;
};

const speak = (text: string, voice: string) =>
  new Promise<{ code: number | null; wav: Buffer | null }>((resolve) => {
    const out = join(mkdtempSync(join(tmpdir(), "speech-")), "a.wav");
    const child = spawnLinuxSpeech(text, voice, out, built());
    child.on("exit", (code) => resolve({ code, wav: existsSync(out) ? readFileSync(out) : null }));
  });

/** A 22050 Hz mono RIFF WAV with some sound in it. */
function isSpeech(wav: Buffer | null) {
  expect(wav).not.toBeNull();
  expect(wav!.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(wav!.readUInt16LE(22)).toBe(1);
  expect(wav!.readUInt32LE(24)).toBe(22050);
  expect(wav!.length).toBeGreaterThan(1000);
}

describe("Linux speech", () => {
  it("has a voice for every app language", () => {
    expect(linuxVoices).toEqual({ tr: "tr", en: "en-us", de: "de", fr: "fr", es: "es", it: "it", pt: "pt-br", ru: "ru", ja: "ja", ko: "ko", zh: "cmn" });
  });

  it("puts the text on stdin, never among the arguments", () => {
    expect(linuxSpeakArgs("/r/espeak-ng", "tr", "/u/a.wav")).toEqual(["--path=/r/espeak-ng", "-v", "tr", "-s", "175", "-w", "/u/a.wav", "--stdin"]);
  });

  it("finds the built-in espeak-ng in the resources and in the build cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "espeak-"));
    mkdirSync(join(dir, "espeak-ng"));
    writeFileSync(join(dir, "espeak-ng", "espeak-ng"), "");
    expect(espeakDir({ packaged: true, resourcesPath: dir, home: "/nowhere", system: "linux" })).toBe(join(dir, "espeak-ng"));
    const cache = join(dir, ".vunemi-build", "espeak-cache", "1.52.0-linux-arm64", "espeak-ng");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "espeak-ng"), "");
    expect(espeakDir({ packaged: false, resourcesPath: "/nowhere", home: dir, system: "linux", arch: "arm64" })).toBe(cache);
    expect(espeakDir({ packaged: false, resourcesPath: "/nowhere", home: "/nowhere", system: "linux" })).toBeNull();
  });

  describe.skipIf(!linux)("with the built espeak-ng", { timeout: 30_000 }, () => {
    const sentences: Record<string, string> = {
      tr: "Bugün hava çok güzel, değil mi?", "en-us": "The weather is lovely today.", de: "Das Wetter ist heute schön.", fr: "Il fait très beau aujourd'hui.",
      es: "Hoy hace muy buen tiempo.", it: "Oggi il tempo è bellissimo.", "pt-br": "O tempo está ótimo hoje.", ru: "Сегодня прекрасная погода.",
      ja: "きょうは いい てんき です。", ko: "오늘 날씨가 정말 좋습니다.", cmn: "今天天气很好。",
    };

    it("turns a sentence in each language into speech", async () => {
      for (const voice of Object.values(linuxVoices)) {
        const { code, wav } = await speak(sentences[voice]!, voice);
        expect(code, voice).toBe(0);
        isSpeech(wav);
      }
    });

    it("speaks text that looks like options as text", async () => {
      const { code, wav } = await speak('-v en "quoted" --help', "en-us");
      expect(code).toBe(0);
      isSpeech(wav);
    });

    it("finishes on text with nothing to say", async () => {
      const { code } = await speak("🙂🙂", "en-us");
      expect(code).toBe(0);
    });

    it("stopping while it speaks gives up that sentence and leaves no file behind", async () => {
      const userData = mkdtempSync(join(tmpdir(), "voice-"));
      const voice = new Voice(userData, { offered: false, espeak: built() });
      expect(voice.status().canSpeak).toBe(true);
      const made = voice.synthesize("This is a long sentence. ".repeat(40));
      setTimeout(() => voice.stopSpeaking(), 50);
      await expect(made).rejects.toThrow();
      expect(readdirSync(join(userData, "speech"))).toEqual([]);
    });
  });

  it.skipIf(!linux)("says it can't speak on Linux without espeak-ng", () => {
    const voice = new Voice(mkdtempSync(join(tmpdir(), "voice-")), { offered: false, espeak: null });
    expect(voice.status().canSpeak).toBe(false);
  });
});
