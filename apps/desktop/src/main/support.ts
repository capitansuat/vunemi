/**
 * Where "Report a problem" goes: the support form on vunemi.com, in the
 * app's language. The version rides after the "#", so it fills in the form
 * without reaching the server; nothing else leaves the Mac, and the user
 * writes and sends the report themselves.
 */

const SITE = "https://vunemi.com";
const LANGUAGES = new Set(["tr", "en", "de", "fr", "es", "it", "pt", "ru", "zh", "ja", "ko"]);
const VERSION = /^[0-9A-Za-z.-]{1,40}$/;

export function supportUrl(locale: string, version: string): string {
  const lang = LANGUAGES.has(locale) ? locale : "en";
  const page = `${SITE}/${lang}/support/`;
  return VERSION.test(version) ? `${page}#version=${version}` : page;
}
