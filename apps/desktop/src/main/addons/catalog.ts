/**
 * The add-ons: programs Vunemi can use but does not carry. Each is one file
 * from the project's own release page, pinned by size and SHA-256, and
 * downloaded only when the user asks for it in Settings.
 *
 * They are the ArtCraft team's Craft apps (MIT or Apache-2.0), in their
 * headless command-line form. Vunemi runs them as they were published:
 * signed by their developer and notarized by Apple.
 */

import type { AddonId } from "../../shared/ipc.js";

export type { AddonId };

export interface AddonSource {
  id: AddonId;
  /** The program's own name, shown beside what it is for. */
  engine: string;
  /** owner/name on GitHub. */
  repo: string;
  tag: string;
  file: string;
  /** The folder the zip unpacks to. */
  folder: string;
  binary: string;
  size: number;
  sha256: string;
}

/** Learning Machines LLC, who sign every Craft release. */
export const ADDON_TEAM = "DJ6XS33FX8";

const craft = (id: AddonId, engine: string, version: string, size: number, sha256: string): AddonSource => {
  const name = engine.toLowerCase();
  const folder = `${name}-cli-${version}-macos-universal`;
  return { id, engine, repo: `storytold/${name}`, tag: `v${version}`, file: `${folder}.zip`, folder, binary: `${name}-cli`, size, sha256 };
};

export const ADDONS: readonly AddonSource[] = [
  craft("documents", "WordCraft", "0.5.0", 80_818_424, "9ded04712fad32c955b32c4efccbe4468fd95eae4f18ea3e32dd3355e6674b5b"),
  craft("sheets", "GridCraft", "0.5.0", 9_154_129, "4559b42d96bafcbc4180cc7f09d5f428597ec19d447c3df2e4b458afcb4c04fc"),
  craft("slides", "DeckCraft", "0.5.0", 66_680_532, "e4f8562c4c56337d2ae4069d182e2e325ddbf700b6248272d96f3e469702990b"),
  craft("pdf", "PdfCraft", "0.6.0", 58_516_543, "85bf80b0732f2556f3133e25693d1f1dfdd2683cd6236aa154bb19f73515b7cf"),
  craft("drawing", "VectorCraft", "0.9.0", 69_756_789, "0e6fc38dd1ec432fb4a133ee1b1efe935d739f0fcb376b1925ee89473d55a61b"),
  craft("photo", "PhotoCraft", "0.7.0", 64_701_365, "caf41eee1827ef740bc4495fb1fee77f6a4e0be82fb131106ad06cd591fd8091"),
  craft("video", "FilmCraft", "0.6.0", 59_471_173, "7ede2aa3e8994ca8363618ef649526546cf951b11a8eaf895b9471101cf5bd32"),
];

export function addonUrl(a: AddonSource): string {
  return `https://github.com/${a.repo}/releases/download/${a.tag}/${a.file}`;
}

/** GitHub, and the hosts it sends a release download on to. */
export function allowedAddonUrl(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" && (host === "github.com" || host.endsWith(".githubusercontent.com"));
}
