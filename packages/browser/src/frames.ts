/**
 * Frames from other sites that stay closed to the agent.
 *
 * A frame from another site is read like the page around it (see page.ts),
 * with two exceptions. A CAPTCHA is the user's to answer: its frame is not
 * read, so nothing in it has a ref and nothing in it can be clicked. An ad
 * is not part of the page the user asked about, it fills the outline with
 * what nobody wants, and it is the likeliest place for text written at an
 * assistant.
 *
 * Both lists are the well-known hosts, not a blocklist that tries to be
 * complete: a challenge from somewhere else is still caught by what it says
 * (see challenge.ts), and an ad from somewhere else is read as untrusted
 * page content, like the rest.
 */

const CHALLENGE_HOSTS = /(?:^|\.)(?:recaptcha\.net|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|captcha-delivery\.com|px-cloud\.net)$/;
/** google.com, google.de, google.co.uk, google.com.tr: not a host that only starts like one. */
const GOOGLE_HOST = /^(?:www\.)?google\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;
const AD_HOSTS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|amazon-adsystem\.com|criteo\.com|criteo\.net|taboola\.com|outbrain\.com|pubmatic\.com|rubiconproject\.com|adsrvr\.org)$/;

/** Why a frame at this address is left unread, or null when it is read. */
export function closedFrame(url: string): "challenge" | "ad" | null {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return null;
  }
  const host = at.hostname.toLowerCase();
  if (CHALLENGE_HOSTS.test(host) || host === "challenges.cloudflare.com") return "challenge";
  // reCAPTCHA is served from Google's own hosts, under one path.
  if (GOOGLE_HOST.test(host) && at.pathname.startsWith("/recaptcha/")) return "challenge";
  if (AD_HOSTS.test(host)) return "ad";
  return null;
}
