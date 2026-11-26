/**
 * Answers read aloud on Linux, with espeak-ng built into the app
 * (scripts/build-espeak-linux.sh), into a WAV the window plays as on macOS
 * and Windows. Linux has no voice every desktop carries, so Vunemi brings
 * one: robotic, but in all eleven languages on every machine. Japanese is
 * read in kana only; kanji are not read properly.
 *
 * The text is model output and may contain anything, so it goes on stdin,
 * never into the arguments.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { Locale } from "@vunemi/i18n";
import { builtBinary, type BinaryLookup } from "./engine/binary.js";

/** The espeak-ng release built into the app; scripts/build-espeak-linux.sh must agree. */
export const ESPEAK_TAG = "1.52.0";

/** The espeak-ng voice that reads each app language. */
export const linuxVoices: Record<Locale, string> = {
  tr: "tr", en: "en-us", de: "de", fr: "fr", es: "es", it: "it", pt: "pt-br", ru: "ru", ja: "ja", ko: "ko", zh: "cmn",
};

/** The folder holding espeak-ng and its espeak-ng-data, or null where it isn't built. */
export function espeakDir(opts: BinaryLookup): string | null {
  const bin = builtBinary({ ...opts, system: opts.system ?? "linux" }, "espeak-ng/espeak-ng", "espeak-cache", ESPEAK_TAG);
  return bin ? dirname(bin) : null;
}

/** About the pace of macOS's voices at Vunemi's rate. */
const WORDS_PER_MINUTE = "175";

export function linuxSpeakArgs(dir: string, voice: string, out: string): string[] {
  return [`--path=${dir}`, "-v", voice, "-s", WORDS_PER_MINUTE, "-w", out, "--stdin"];
}

/** Speaks `text` into the WAV `out`. */
export function spawnLinuxSpeech(text: string, voice: string, out: string, dir: string): ChildProcess {
  const child = spawn(`${dir}/espeak-ng`, linuxSpeakArgs(dir, voice, out), { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin?.on("error", () => {}); // a process killed early closes its stdin
  child.stdin?.end(text);
  return child;
}
