/**
 * The "@" in the message box: finding the one being typed, and matching what
 * follows it to the names of conversations and meetings.
 */

/** Rows the menu shows. */
export const MENU_SIZE = 8;
/** A name written into the text is at most this long. */
export const NAME_CHARS = 40;
const QUERY_CHARS = 40;

/**
 * The "@…" being typed at the caret, or null. `picked` are the names already
 * in the text as mentions: typing on after one is the message, not a search.
 */
export function mentionQuery(text: string, caret: number, picked: readonly string[] = []): { start: number; query: string } | null {
  const start = text.lastIndexOf("@", caret - 1);
  if (start === -1) return null;
  // Part of a word (an address, a handle someone pasted) is not a mention.
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null;
  const query = text.slice(start + 1, caret);
  if (query.length > QUERY_CHARS || query.includes("\n") || /^\s/.test(query)) return null;
  const after = text.slice(start + 1);
  if (picked.some((name) => after.startsWith(name))) return null;
  return { start, query };
}

/** Case and accents folded, by the language's own rules for case. */
export function fold(text: string, lower: (s: string) => string): string {
  // The dotless ı has no accent to strip; without this "ISTANBUL" typed in Turkish would not find "İstanbul".
  return lower(text).normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

/** The items whose name holds every word of the query, in the order given. */
export function filterMentions<T extends { name: string }>(items: readonly T[], query: string, lower: (s: string) => string): T[] {
  const words = fold(query, lower).split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const name = fold(item.name, lower);
      return words.every((word) => name.includes(word));
    })
    .slice(0, MENU_SIZE);
}

/**
 * A title as it is written into the text: one line, cut when long. A
 * conversation that began with a mention is titled "@Rome trip …"; its own
 * "@" marks are dropped, or picking it would write "@@Rome trip".
 */
export function mentionName(title: string): string {
  const line = title.replace(/(^|\s)@+/g, "$1").replace(/\s+/g, " ").trim();
  return line.length > NAME_CHARS ? `${line.slice(0, NAME_CHARS - 1).trimEnd()}…` : line;
}

/** Replaces the "@…" being typed with the name picked; the caret lands after it. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const head = `${text.slice(0, start)}@${name}`;
  return { text: `${head}${/^\s/.test(rest) ? "" : " "}${rest}`, caret: head.length + 1 };
}
