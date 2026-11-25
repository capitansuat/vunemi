/**
 * Answers read aloud on Windows, with the voices Windows has (System.Speech,
 * the same voices Narrator offers), into a WAV the window plays as on macOS.
 *
 * The text is model output and may contain anything, so it is never part of
 * a command line or of the script. PowerShell gets one fixed script, base64
 * encoded on its command line (a command, so the execution policy is not
 * involved and is not bypassed), and the text arrives on stdin as one line
 * of JSON in plain ASCII: PowerShell 5.1 reads stdin in the console's code
 * page, which would mangle Turkish letters, while \u escapes survive any.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Locale } from "@vunemi/i18n";

/** The culture whose voice reads each app language. */
export const windowsVoiceCultures: Record<Locale, string> = {
  tr: "tr-TR", en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", it: "it-IT", pt: "pt-BR", ru: "ru-RU", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN",
};

/**
 * Reads `{ text, culture, rate, out }` from stdin; picks an installed voice of
 * that culture, else of that language, else Windows' default (as macOS's say
 * does without a voice for the language); writes 22050 Hz 16-bit mono WAV.
 */
const SCRIPT = `$ErrorActionPreference = 'Stop'
$req = [Console]::In.ReadLine() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
  $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq $req.culture } | Select-Object -First 1
  if (-not $pick) { $lang = ([string]$req.culture).Split('-')[0]; $pick = $voices | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $lang } | Select-Object -First 1 }
  if ($pick) { $s.SelectVoice($pick.VoiceInfo.Name) }
  $s.Rate = [int]$req.rate
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList 22050, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile([string]$req.out, $format)
  $s.Speak([string]$req.text)
} finally { $s.Dispose() }
`;

export function windowsSpeakScript(): string {
  return SCRIPT;
}

/** PowerShell's arguments: always the same, whatever is said. */
export function windowsSpeakArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")];
}

/** The one stdin line: JSON with everything outside printable ASCII escaped. */
export function windowsSpeakRequest(text: string, culture: string, out: string): string {
  const json = JSON.stringify({ text, culture, rate: 1, out });
  return `${json.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/** Windows' own PowerShell, by its full path rather than whatever PATH finds first. */
function powershell(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Starts speaking `text` into `out`; the caller watches the process and may kill it. */
export function spawnWindowsSpeech(text: string, culture: string, out: string): ChildProcess {
  const child = spawn(powershell(), windowsSpeakArgs(), { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.stdin?.on("error", () => {}); // a process killed early closes its stdin
  child.stdin?.end(windowsSpeakRequest(text, culture, out));
  return child;
}

/** Speaks `text` into `out` and waits for it. */
export function windowsSpeak(text: string, culture: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnWindowsSpeech(text, culture, out);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`speech exited with ${code}`))));
  });
}
