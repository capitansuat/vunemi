/**
 * Secrets the Vault doesn't know about. The Vault masks what the user stored
 * in it; a key that turns up in a page, a file or a mail — someone's `.env`
 * pasted into a document, a token in a log — reaches the model, the summary
 * and the saved conversation as it is. These shapes are specific enough to
 * hide without asking: a false alarm costs a word, a miss costs a key.
 *
 * Best effort by design, and no substitute for the Vault or the Sentinel.
 */

export const SECRET_MASK = "[hidden secret]";

/** Whole-value shapes: nothing around them needs keeping. */
const KEYS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /\b[rs]k_live_[A-Za-z0-9]{16,}/g, // Stripe
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // a signed token (JWT)
];

/** A label, then the value: the label stays so the text still reads. */
const BEARER = /\b(Bearer)[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi;
// In JSON the key's closing quote comes before the colon.
const ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd)\b(["']?\s*[:=]\s*)(["']?)[^\s"']{8,}/gi;
/** The password in scheme://user:password@host; who and where stay readable. */
const ADDRESS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:)[^\s:/@]{3,}(@)/gi;

export function maskSecrets(text: string): string {
  let out = text;
  for (const key of KEYS) out = out.replace(key, SECRET_MASK);
  out = out.replace(BEARER, `$1 ${SECRET_MASK}`).replace(ADDRESS, `$1${SECRET_MASK}$2`);
  return out.replace(ASSIGNMENT, `$1$2$3${SECRET_MASK}`);
}
