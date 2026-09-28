/**
 * What whisper writes when a stretch of a meeting held no words: subtitle
 * credits and sign-offs from the films it learned from. Matched whole, as
 * dictation does, so a sentence that merely contains one is kept.
 */
import { clean } from "../voice.js";

const CREDITS = new Set(
  [
    "subtitles by the amara.org community",
    "altyazılar amara.org topluluğu tarafından",
    "untertitel der amara.org-community",
    "untertitel im auftrag des zdf, 2017",
    "sous-titres réalisés para la communauté d'amara.org",
    "sous-titrage st' 501",
    "subtítulos realizados por la comunidad de amara.org",
    "продолжение следует",
    "ご視聴ありがとうございました",
    "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目",
    "please subscribe",
    "thank you for watching",
    "thanks for watching",
    "izlediğiniz için teşekkürler",
    "izlediğiniz için teşekkür ederim",
    "abone olmayı unutmayın",
    "altyazı m.k",
  ].map((t) => t.toLocaleLowerCase("tr")),
);

export function silencePhrase(text: string): boolean {
  const said = clean(text);
  if (!/[\p{L}\p{N}]/u.test(said)) return true;
  return CREDITS.has(said.toLocaleLowerCase("tr").replace(/[\s.!?…]+$/u, ""));
}
