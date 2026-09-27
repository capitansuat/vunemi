/**
 * Recognises bot checks (CAPTCHAs, "unusual traffic" walls, Cloudflare
 * interstitials). The agent never tries to get past these; the tools hand the
 * page to the user instead.
 *
 * Deliberately conservative: an invisible reCAPTCHA badge sits on many
 * ordinary login forms, so an iframe named "reCAPTCHA" alone doesn't count.
 * Only a challenge the user actually has to answer does.
 */

import type { AXNode } from "@vunemi/perception";

const URL_SIGNS: [RegExp, string][] = [
  [/^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\//i, "Google unusual-traffic check"],
  [/\/cdn-cgi\/challenge-platform\//i, "Cloudflare check"],
  [/^https?:\/\/challenges\.cloudflare\.com\//i, "Cloudflare check"],
];

const TEXT_SIGNS: [RegExp, string][] = [
  [/unusual traffic from your computer|olağan dışı trafik|alışılmadık trafik/i, "unusual-traffic check"],
  [/\bI'?m not a robot\b|ben robot değilim/i, "CAPTCHA"],
  [/verify (that )?you are (a )?human|insan olduğunuzu doğrulay/i, "human verification"],
  [/checking (if the site connection is secure|your browser)/i, "browser check"],
  [/recaptcha challenge|hcaptcha challenge|select all (images|squares) with/i, "CAPTCHA"],
];

/**
 * Titles a wall puts up when it has nothing else to show. Only trusted when
 * the page is otherwise empty: "Güvenlik" is also an ordinary menu item.
 */
const TITLE_SIGNS =
  /güvenlik|security check|access denied|erişim engellendi|forbidden|attention required|just a moment|bir dakika|are you a robot/i;

/**
 * A wall that renders nothing looks exactly like a page that failed to load,
 * so the count has to be low enough to mean "nothing arrived at all".
 */
const EMPTY_ENOUGH = 3;

export function detectChallenge(url: string, nodes: readonly AXNode[]): string | null {
  for (const [re, what] of URL_SIGNS) if (re.test(url)) return what;

  let title = "";
  let named = 0;
  for (const n of nodes) {
    if (n.ignored) continue;
    const name = typeof n.name?.value === "string" ? n.name.value : "";
    if (!name) continue;
    if (n.role?.value === "RootWebArea") {
      title = name;
      continue;
    }
    named++;
    for (const [re, what] of TEXT_SIGNS) if (re.test(name)) return what;
  }

  // Nothing but a title, and the title is a wall's: the page never arrived.
  if (named <= EMPTY_ENOUGH && TITLE_SIGNS.test(title)) return "bot protection";
  return null;
}
