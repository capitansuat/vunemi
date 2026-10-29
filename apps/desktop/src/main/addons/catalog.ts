/**
 * The add-ons: programs Vunemi can use but does not carry. Each is one file,
 * pinned by size and SHA-256, and downloaded only when the user asks for it
 * in Settings.
 *
 * The file comes from Vunemi's own release page, not the project's: it is the
 * exact copy the tools here were written and tried against, and it stays
 * there whatever the project later does with its own releases. It is the
 * project's published file, byte for byte, so it is still signed by its
 * developer and notarized by Apple, and its licence files travel inside it.
 *
 * The first ones are the ArtCraft team's Craft apps (MIT or Apache-2.0), in
 * their headless command-line form.
 */

import type { AddonCategory, AddonId } from "../../shared/ipc.js";

export type { AddonId };

/**
 * One row of the catalogue. The list is meant to grow: a new add-on is a row
 * here, its texts in the language catalogs, and its tools (see tools.ts).
 */
export interface AddonSource {
  id: AddonId;
  category: AddonCategory;
  /** The program's own name, shown beside what it is for. */
  engine: string;
  publisher: string;
  /** SPDX expression, as the project states it. */
  licence: string;
  /** The project itself, owner/name on GitHub: where the user can read about it. */
  repo: string;
  /** The project's own version tag; also the name of the folder it is installed in. */
  tag: string;
  /** The Vunemi release that holds the copy (see ADDON_SHELF). */
  shelf: string;
  file: string;
  /** The folder the zip unpacks to. */
  folder: string;
  binary: string;
  size: number;
  sha256: string;
}

/** Where the copies are kept: releases of Vunemi's own repository, apart from the app's versions. */
export const ADDON_SHELF = "capitansuat/vunemi";

/** Learning Machines LLC, who sign every Craft release. */
export const ADDON_TEAM = "DJ6XS33FX8";

const craft = (id: AddonId, category: AddonCategory, engine: string, version: string, size: number, sha256: string): AddonSource => {
  const name = engine.toLowerCase();
  const folder = `${name}-cli-${version}-macos-universal`;
  return { id, category, engine, publisher: "ArtCraft", licence: "MIT OR Apache-2.0", repo: `storytold/${name}`, tag: `v${version}`, shelf: "addons-2", file: `${folder}.zip`, folder, binary: `${name}-cli`, size, sha256 };
};

export const ADDONS: readonly AddonSource[] = [
  craft("documents", "office", "WordCraft", "0.12.0", 94_748_190, "dc030590fdd9cb5971c38bc79cadecf30f68f6d46b67a456a8f53a46990b6de4"),
  craft("sheets", "office", "GridCraft", "0.13.0", 11_835_794, "3db52969cf7621fdfdaebd123f72d5b1de343f63d3b52ec5a4a964f5605986ac"),
  craft("slides", "office", "DeckCraft", "0.12.0", 93_735_843, "dfd374a5af7139344bf06fbb52beb6f0f255e54276ae20b5d457ce4f958a8322"),
  craft("pdf", "office", "PdfCraft", "0.15.0", 83_973_078, "0304db20f3597e4e9ad3044d67f79cb89bdad49833c6ad7a60c0d0d6a7afaa50"),
  craft("drawing", "images", "VectorCraft", "0.18.0", 115_481_401, "694d216cc0ac8ff32dc1c32ffa318da9e5229d58bc821e378eef6f3739286744"),
  craft("photo", "images", "PhotoCraft", "0.17.0", 106_003_284, "6edff99cc1977508bea9b5566f551374e7b8ef42a21502ee084a1d969f0d54c0"),
  craft("video", "video", "FilmCraft", "0.14.0", 93_928_472, "c9dc8dfd9c63edb2f793f0727dc9816e4432ea545fa8cd7331d242944d843087"),
];

export function addonUrl(a: AddonSource): string {
  return `https://github.com/${ADDON_SHELF}/releases/download/${a.shelf}/${a.file}`;
}

/** GitHub, and the hosts it sends a release download on to. */
export function allowedAddonUrl(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" && (host === "github.com" || host.endsWith(".githubusercontent.com"));
}
