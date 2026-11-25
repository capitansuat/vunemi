/**
 * Answers read aloud on Windows: a fixed PowerShell script, the text only
 * ever on stdin as JSON. Synthetic text only.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsSpeak, windowsSpeakArgs, windowsSpeakRequest, windowsSpeakScript, windowsVoiceCultures } from "../../src/main/speech-windows.js";
const onWindows = process.platform === "win32";

const tricky = 'Bugün "fiyat" $(Get-Date); `whoami` & del *\nikinci satır şğüİı';

describe("reading aloud on Windows", () => {
  it("runs one fixed script, never with the text and never past the execution policy", () => {
    const args = windowsSpeakArgs();
    expect(args.join(" ")).not.toMatch(/ExecutionPolicy|Bypass/i);
    expect(args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(args[2]).toBe("-EncodedCommand");
    expect(Buffer.from(args[3]!, "base64").toString("utf16le")).toBe(windowsSpeakScript());
    expect(windowsSpeakArgs()).toEqual(args);
  });

  it("reads what to say from stdin and never runs it", () => {
    const script = windowsSpeakScript();
    expect(script).toContain("[Console]::In.ReadLine()");
    expect(script).toContain("ConvertFrom-Json");
    expect(script).not.toMatch(/Invoke-Expression|\biex\b|\{text\}|%s/i);
  });

  it("sends the text as one ASCII JSON line that comes back exactly", () => {
    const line = windowsSpeakRequest(tricky, "tr-TR", "C:\\Users\\deneme\\speech\\a.wav");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(/^[\x20-\x7e]*\n$/.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual({ text: tricky, culture: "tr-TR", rate: 1, out: "C:\\Users\\deneme\\speech\\a.wav" });
  });

  it("asks for a voice in each app language", () => {
    expect(windowsVoiceCultures).toEqual({
      tr: "tr-TR", en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", it: "it-IT", pt: "pt-BR", ru: "ru-RU", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN",
    });
  });

  it.runIf(onWindows)("speaks into a 22 kHz WAV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-speech-"));
    try {
      const out = join(dir, "a.wav");
      await windowsSpeak("deneme bir iki", "en-US", out);
      const wav = readFileSync(out);
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readInt32LE(24)).toBe(22050);
      // 16-bit mono: 44,100 bytes a second; more than 0.2 s of sound.
      expect(wav.length - 44).toBeGreaterThan(0.2 * 44_100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
