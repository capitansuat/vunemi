/**
 * What vunemi.com says the latest Vunemi is, read with suspicion: the site
 * could be wrong or someone else's, so an offer is made only for a later
 * version whose zip is exactly where our releases live. Squirrel.Mac then
 * refuses the zip unless it is signed like the running app.
 */

export const FEED_URL = "https://vunemi.com/update/mac-arm64.json";

/** Where the feed and the zips are. Production, or a local test server. */
export interface FeedSource {
  feed: string;
  zip(version: string): string;
}

export const PRODUCTION: FeedSource = {
  feed: FEED_URL,
  zip: (version) => `https://github.com/capitansuat/vunemi/releases/download/v${version}/Vunemi-${version}-arm64.zip`,
};

export interface Offer {
  version: string;
  /** "What's new", in the app's language when the feed has it. */
  notes: string[];
  sizeMb: number | null;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-test(\d+))?$/;
const MAX_NOTES = 20;
const NOTE_CHARS = 300;

/** A release as numbers; a test build sorts before the release it leads to. */
function parts(version: string): number[] | null {
  const m = VERSION.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[4])];
}

/** Whether `a` is a later version than `b`. Anything unreadable is not. */
export function newer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The offer the feed makes to this Vunemi, or null when there is none it can trust. */
export function readFeed(value: unknown, current: string, locale: string, source: FeedSource): Offer | null {
  const feed = record(value);
  const version = feed?.currentRelease;
  if (!feed || typeof version !== "string" || !newer(version, current)) return null;
  const releases = Array.isArray(feed.releases) ? feed.releases : [];
  const entry = releases.map(record).find((r) => r?.version === version);
  const to = record(entry?.updateTo);
  if (!to || to.version !== version || to.url !== source.zip(version)) return null;
  const notes = record(feed.notes);
  const list: unknown[] = Array.isArray(notes?.[locale]) ? (notes![locale] as unknown[]) : Array.isArray(notes?.en) ? (notes!.en as unknown[]) : [];
  const size = feed.sizeMb;
  return {
    version,
    notes: list.filter((n): n is string => typeof n === "string").slice(0, MAX_NOTES).map((n) => n.slice(0, NOTE_CHARS)),
    sizeMb: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
  };
}
