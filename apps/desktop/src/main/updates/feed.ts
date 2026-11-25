/**
 * What vunemi.com says the latest Vunemi is, read with suspicion: the site
 * could be wrong or someone else's, so an offer is made only for a later
 * version whose zip is exactly where our releases live. Squirrel.Mac then
 * refuses the zip unless it is signed like the running app.
 */

import { verifyUpdate, type UpdateArch } from "./signature.js";

export const FEED_URL = "https://vunemi.com/update/mac-arm64.json";

/** Where the feed and the zips are. Production, or a local test server. */
export interface FeedSource {
  feed: string;
  zip(version: string): string;
  /**
   * Windows: the installer's address is checked by this instead of `zip`,
   * and the offer must carry a SHA-256 and a signature that this key and
   * architecture verify. Null key: nothing is offered.
   */
  signed?: { arch: UpdateArch; publicKey: string | null; accepts(url: string, version: string): boolean };
}

const RELEASES = "https://github.com/capitansuat/vunemi/releases/download/";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Windows feed for this architecture: installers only from the releases, only with the key's signature. */
export function windowsSource(arch: UpdateArch, publicKey: string | null): FeedSource {
  return {
    feed: `https://vunemi.com/update/win-${arch}.json`,
    zip: (version) => `${RELEASES}v${version}/Vunemi-Setup-${version}-${arch}.exe`,
    signed: {
      arch,
      publicKey,
      // Any release tag (a Windows build may have its own), but this file name exactly.
      accepts: (url, version) => new RegExp(`^${escape(RELEASES)}[A-Za-z0-9._-]+/Vunemi-Setup-${escape(version)}-${arch}\\.exe$`).test(url) && !url.includes(".."),
    },
  };
}

/** A local test feed for a Windows test build (VUNEMI_UPDATE_FEED), with the same signature check. */
export function localWindowsSource(base: string, arch: UpdateArch, publicKey: string | null): FeedSource {
  const installer = (version: string) => `${base}Vunemi-Setup-${version}-${arch}.exe`;
  return { feed: `${base}win-${arch}.json`, zip: installer, signed: { arch, publicKey, accepts: (url, version) => url === installer(version) } };
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
  /** Windows: the signed installer and its SHA-256, which the download must match. */
  url?: string;
  sha256?: string;
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
  if (!to || to.version !== version || typeof to.url !== "string") return null;
  let signed: { url: string; sha256: string } | null = null;
  if (source.signed) {
    const { arch, publicKey, accepts } = source.signed;
    const sha256 = typeof to.sha256 === "string" ? to.sha256.toLowerCase() : "";
    if (!publicKey || !accepts(to.url, version) || !verifyUpdate(publicKey, version, arch, sha256, to.signature)) return null;
    signed = { url: to.url, sha256 };
  } else if (to.url !== source.zip(version)) return null;
  const notes = record(feed.notes);
  const list: unknown[] = Array.isArray(notes?.[locale]) ? (notes![locale] as unknown[]) : Array.isArray(notes?.en) ? (notes!.en as unknown[]) : [];
  const size = feed.sizeMb;
  return {
    version,
    notes: list.filter((n): n is string => typeof n === "string").slice(0, MAX_NOTES).map((n) => n.slice(0, NOTE_CHARS)),
    sizeMb: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
    ...signed,
  };
}
