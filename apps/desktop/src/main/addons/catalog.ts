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
  return { id, category, engine, publisher: "ArtCraft", licence: "MIT OR Apache-2.0", repo: `storytold/${name}`, tag: `v${version}`, shelf: "addons-4", file: `${folder}.zip`, folder, binary: `${name}-cli`, size, sha256 };
};

export const ADDONS: readonly AddonSource[] = [
  craft("documents", "office", "WordCraft", "0.18.1", 103_018_289, "34397cf6fcf73ee8ae8d53cab08fbdfc213262dbb6753c2965ebb7cde37b8616"),
  craft("sheets", "office", "GridCraft", "0.19.1", 16_006_487, "7c2895ebad0bbd92b65c622ba7e22ada56e0498065dfdbd433111ba1e225eb8a"),
  craft("slides", "office", "DeckCraft", "0.18.1", 94_288_920, "10992f73c88a4c0361dd0fec3a4d7490731ffb3ea9658ee2274b396e3341af00"),
  craft("pdf", "office", "PdfCraft", "0.21.1", 92_333_447, "337a9f644744b57e10de41c57366e53c5ccf8840a4d5dc7322b17b9b83fdc2fa"),
  craft("drawing", "images", "VectorCraft", "0.24.1", 133_990_423, "7f0c8261e5c831d9681e48272f9ba73bf8702dbf6ceb84f98177c7c007faddf2"),
  craft("photo", "images", "PhotoCraft", "0.23.1", 120_474_491, "a6ecdc6d4add02881642bda0a0b191b4974118651f2ec5641dc71b2c3ff4b752"),
  craft("video", "video", "FilmCraft", "0.20.1", 100_056_028, "1651d9defb54f853cbd69016428bb9f72a7bf26d56e4755b8e2a79535fd0ac82"),
];

export function addonUrl(a: AddonSource): string {
  return `https://github.com/${ADDON_SHELF}/releases/download/${a.shelf}/${a.file}`;
}

/** GitHub, and the hosts it sends a release download on to. */
export function allowedAddonUrl(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" && (host === "github.com" || host.endsWith(".githubusercontent.com"));
}
