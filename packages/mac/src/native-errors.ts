/** English fallback for the native helper's older Turkish diagnostics.
 * Keep this in the main process: changing the signed Swift helper would
 * change its Keychain identity and could strand an existing vault key.
 */
import { getLocale, t } from "@vunemi/i18n";

const exact: Record<string, string> = {
  "yanıt veren uygulama yok": "No app responded to the Accessibility check.",
  "tamam": "ok",
  "erişilebilirlik kapalı (apiDisabled)": "Accessibility is disabled (apiDisabled).",
  "Erişilebilirlik izni yok.": "Accessibility permission is missing.",
  "Erişilebilirlik izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Erişilebilirlik.": "Accessibility permission is missing. Open System Settings › Privacy & Security › Accessibility.",
  "Ekran kaydı izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı.": "Screen Recording permission is missing. Open System Settings › Privacy & Security › Screen Recording.",
  "Bu uygulamanın menü çubuğu okunamıyor.": "This app's menu bar could not be read.",
  "Bu uygulama açık ama penceresi yok (hepsi kapatılmış olabilir). Menüsü için part=\"menu\" kullan.": "This app is open but has no window. Use part=\"menu\" for its menu bar.",
  "Bu uygulamanın ekranda görünen bir penceresi yok.": "This app has no visible window on screen.",
  "Ekran görüntüsü alınamadı.": "The screenshot could not be captured.",
  "Görüntü yazılamadı.": "The image could not be written.",
  "Görüntü kaydedilemedi.": "The image could not be saved.",
  "Uygulama bulunamadı.": "The app could not be found.",
  "Bu öğenin ekranda bir yeri yok.": "This item has no position on screen.",
  "Yazılacak bir metin gerekiyor.": "Text to type is required.",
  "Görüntünün yazılacağı bir yol gerekiyor.": "An output path for the image is required.",
  "Bitiş, başlangıçtan sonra olmalı.": "The end must be after the start.",
  "Etkinliğin bir başlığı olmalı.": "The event needs a title.",
  "Etkinlik kimliği gerekiyor.": "An event ID is required.",
  "Anımsatıcının bir başlığı olmalı.": "The reminder needs a title.",
  "Anımsatıcı kimliği gerekiyor.": "A reminder ID is required.",
  "Bilinmeyen takvim türü.": "Unknown calendar type.",
  "İzin penceresi yanıtlanmadı.": "The permission prompt was not answered.",
  "Anımsatıcılar okunamadı.": "Reminders could not be read.",
  "Yazılabilir bir takvim bulunamadı.": "No writable calendar was found.",
  "O etkinlik artık yok.": "That event no longer exists.",
  "Yazılabilir bir anımsatıcı listesi bulunamadı.": "No writable reminders list was found.",
  "O anımsatıcı bulunamadı.": "That reminder could not be found.",
  "O anımsatıcı artık yok.": "That reminder no longer exists.",
  "Anahtar zincirindeki Kasa anahtarı beklenen biçimde değil; dokunulmadı.": "The vault key in Keychain has an unexpected format. It was left untouched.",
  "Rastgele anahtar üretilemedi.": "A random vault key could not be generated.",
  "Okunamayan istek.": "The desktop helper could not read the request.",
};

/** Raw OS errors are left intact; known Turkish helper errors get English text outside Turkish UI. */
export function nativeErrorText(raw: string): string {
  if (getLocale() === "tr") return raw;
  if (exact[raw]) return exact[raw];
  let match: RegExpMatchArray | null;
  if ((match = raw.match(/^"(.*)" diye açık bir uygulama yok\.$/))) return `No open app named "${match[1]}" was found.`;
  if ((match = raw.match(/^"(.*)" tuşu tanınmıyor\.$/))) return `The key "${match[1]}" is not recognised.`;
  if ((match = raw.match(/^"(.*)" diye bir değiştirici tuş yok\.$/))) return `The modifier key "${match[1]}" is not recognised.`;
  if ((match = raw.match(/^\[(-?\d+)\] diye bir öğe yok\. Önce describe çağır\.$/))) return `Item [${match[1]}] was not found. Describe the window again first.`;
  if ((match = raw.match(/^O adda bir takvim yok\. Olanlar: (.*)\.$/))) return `No calendar with that name was found. Available calendars: ${match[1]}.`;
  if ((match = raw.match(/^O adda bir liste yok\. Olanlar: (.*)\.$/))) return `No reminders list with that name was found. Available lists: ${match[1]}.`;
  if ((match = raw.match(/^"(.*)" diye yazılabilir bir takvim yok\. Olanlar: (.*)\.$/))) return `No writable calendar named "${match[1]}" was found. Available calendars: ${match[2]}.`;
  if ((match = raw.match(/^(Başlangıç|Bitiş) okunabilir bir tarih değil \(ISO 8601 bekleniyor\)\.$/))) return `${match[1] === "Başlangıç" ? "Start" : "End"} is not a valid ISO 8601 date.`;
  if ((match = raw.match(/^(Takvim|Anımsatıcılar) izni verilmemiş\./))) return `${match[1] === "Takvim" ? "Calendar" : "Reminders"} permission is missing. Open System Settings › Privacy & Security.`;
  if ((match = raw.match(/^Anahtar zinciri Kasa anahtarını vermedi: (.*)$/))) return `Keychain did not return the vault key: ${match[1]}`;
  if ((match = raw.match(/^Kasa anahtarı anahtar zincirine yazılamadı: (.*)$/))) return `The vault key could not be saved to Keychain: ${match[1]}`;
  if ((match = raw.match(/^Bilinmeyen işlem: (.*)$/))) return `Unknown helper operation: ${match[1]}`;
  if (/^uygulama: AXError -?\d+$/.test(raw)) return raw.replace(/^uygulama:/, "app:");
  if (raw.startsWith("Pencere okunamadı —")) return "The app window could not be read. Check Vunemi's Accessibility permission in System Settings, then restart Vunemi.";
  if (raw.startsWith("macOS bu uygulamanın")) return "macOS sees an app window, but the app does not expose it through Accessibility. Try its menu bar or inspect the window yourself.";
  if (/[ÇĞİÖŞÜçğıöşü]/.test(raw) || /^(Bu|O|Bilinmeyen|Anahtar|Kasa|Takvim|Erişilebilirlik|Görüntü|Yazılabilir|İzin|Etkinliğin|Anımsatıcı)(?![A-Za-z])/.test(raw)) return t("mac.helper.failed");
  return raw;
}
