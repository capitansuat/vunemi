/**
 * Links in an answer that nothing in the conversation showed.
 *
 * A fact on an option card is checked against the page it was read on. A
 * link in a plain answer was not checked against anything: a model writes
 * addresses from memory, most of them right and some of them made up, and
 * both read the same. This finds the ones the conversation never held, so
 * the answer can say which they are. It is a statement about where the
 * address came from, not about whether it works.
 */

/** An address as it is compared: no scheme, no fragment, no closing slash, host in lower case. */
function key(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

/** The addresses a text holds, as they are written, without the punctuation around them. */
export function writtenAddresses(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\\|]+/g)) {
    // A sentence's full stop or a closing bracket is not part of the address.
    let raw = match[0].replace(/[.,;:!?…*_]+$/u, "");
    while (/[)\]}]$/.test(raw) && !balanced(raw)) raw = raw.slice(0, -1);
    found.push(raw.replace(/[.,;:!?…*_]+$/u, ""));
  }
  return found;
}

/** The addresses a text holds, each as it is compared. */
export function addressesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of writtenAddresses(text)) {
    const k = key(raw);
    if (k !== null) found.add(k);
  }
  return found;
}

/** "…/Rust_(programming_language)" keeps its bracket; "(see https://a.example/x)" gives its back. */
function balanced(raw: string): boolean {
  const count = (char: string) => raw.split(char).length - 1;
  return count("(") >= count(")") && count("[") >= count("]") && count("{") >= count("}");
}

const LINK = /\[[^\]]+\]\(([^)\s]+)\)/g;

/**
 * The addresses an answer gives whose address is not among `seen`, each as
 * the answer wrote it: the Markdown links to https addresses (the only ones
 * the app lets the user click) and the addresses written out in the text,
 * which the user can copy. A link to the front page of a site that was seen
 * counts as seen: nothing in it is invented.
 */
export function unseenLinks(answer: string, seen: ReadonlySet<string>): string[] {
  const hosts = new Set([...seen].map((address) => address.split(/[/?]/)[0]!));
  const unseen: string[] = [];
  const check = (written: string): void => {
    const k = key(written);
    if (k === null || seen.has(k) || (!/[/?]/.test(k) && hosts.has(k))) return;
    if (!unseen.includes(written)) unseen.push(written);
  };
  for (const match of answer.matchAll(LINK)) if (match[1]!.startsWith("https://")) check(match[1]!);
  // What is left is text: a link that isn't https shows its label alone, so its address is not given.
  for (const written of writtenAddresses(answer.replace(LINK, " "))) check(written);
  return unseen;
}
