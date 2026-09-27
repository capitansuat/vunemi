/**
 * The models Vunemi offers someone who has none. One per size of Mac, each
 * pinned to a commit and a SHA-256 so the bytes that arrive can be checked.
 * Newer models come and go every week; this list is reviewed each release,
 * and the search box covers the rest.
 */

import { t } from "@vunemi/i18n";

export const GiB = 1024 ** 3;

/** A model's vision part: a file in the same repository, at the same commit. */
export interface ProjectorSource {
  file: string;
  size: number;
  sha256: string;
}

/** Where a model file comes from, pinned so the bytes can be checked. */
export interface ModelSource {
  repo: string;
  commit: string;
  file: string;
  size: number;
  sha256: string;
  /** For a model that can see; downloaded beside it. */
  projector?: ProjectorSource;
}

export interface CatalogEntry extends ModelSource {
  name: string;
  /** Who made the model (not who converted it), as Hugging Face names them. */
  maker: string;
  license: string;
  /** The least memory, in bytes, a Mac needs for this entry to be offered. */
  minMemory: number;
  /** A smaller build of the same model, named in the user's language. */
  variant?: "compact";
}

/** Largest first. Values, vision parts included, read from the Hugging Face API on 24 Sep 2026. */
export const CATALOG: readonly CatalogEntry[] = [
  {
    name: "Qwen3.6 35B-A3B",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    commit: "a483e9e6cbd595906af30beda3187c2663a1118c",
    file: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    size: 22_360_456_160,
    sha256: "707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450",
    projector: { file: "mmproj-F16.gguf", size: 899_283_680, sha256: "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f" },
    license: "apache-2.0",
    maker: "Qwen",
    minMemory: 48 * GiB,
  },
  {
    name: "Qwen3.6 35B-A3B",
    variant: "compact",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    commit: "a483e9e6cbd595906af30beda3187c2663a1118c",
    file: "Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf",
    size: 16_845_511_648,
    sha256: "a832b9689925f1bd335bbe985cdfb06c36bf2cf268f4f8f6eceafa3ceb515617",
    projector: { file: "mmproj-F16.gguf", size: 899_283_680, sha256: "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f" },
    license: "apache-2.0",
    maker: "Qwen",
    minMemory: 32 * GiB,
  },
  {
    name: "Qwen3.5 9B",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    commit: "3885219b6810b007914f3a7950a8d1b469d598a5",
    file: "Qwen3.5-9B-UD-Q4_K_XL.gguf",
    size: 5_966_095_584,
    sha256: "6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293",
    projector: { file: "mmproj-F16.gguf", size: 918_166_080, sha256: "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f" },
    license: "apache-2.0",
    maker: "Qwen",
    minMemory: 16 * GiB,
  },
  {
    // The one measured on the smallest Macs: 12 of 12 on the agent eval,
    // about 3.2 GB in use with a 32K context (26 Sep 2026). No vision part:
    // on 8 GB it would crowd the model out.
    name: "Gemma 4 E2B",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    commit: "b4243c156154b6dca9324415f8c7ccc098b4aed1",
    file: "gemma-4-E2B-it-Q4_0.gguf",
    size: 2_841_481_184,
    sha256: "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52",
    license: "apache-2.0",
    maker: "Google",
    minMemory: 0,
  },
  {
    name: "Qwen3.5 4B",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    commit: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    size: 2_912_109_728,
    sha256: "b252c5610a42ca82d20fe2a12813e9d069eed89292907e26c783eeb0bc961bc7",
    projector: { file: "mmproj-F16.gguf", size: 672_423_616, sha256: "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864" },
    license: "apache-2.0",
    maker: "Qwen",
    minMemory: 0,
  },
];

/**
 * The name to show for a model file: the catalogue's, in the user's language,
 * when the file is one of ours (older downloads stored an English suffix).
 */
export function displayName(file: string, stored: string): string {
  const entry = CATALOG.find((e) => e.file === file);
  if (!entry) return stored;
  return entry.variant ? t("engine.variant.compact", { name: entry.name }) : entry.name;
}

/** A model's id in `vunemi:<id>`: its file name, lower-case, without `.gguf`. */
export function modelId(file: string): string {
  return file.replace(/\.gguf$/i, "").toLowerCase();
}

export function recommend(totalMemory: number): CatalogEntry {
  return CATALOG.find((e) => totalMemory >= e.minMemory) ?? CATALOG[CATALOG.length - 1]!;
}

export function smaller(file: string): CatalogEntry | null {
  const i = CATALOG.findIndex((e) => e.file === file);
  return i >= 0 && i < CATALOG.length - 1 ? CATALOG[i + 1]! : null;
}

export function contextFor(totalMemory: number): number {
  if (totalMemory >= 48 * GiB) return 65_536;
  if (totalMemory >= 16 * GiB) return 32_768;
  return 16_384;
}

/** Half the memory: the rest is macOS, the user's apps, and the model's working memory. */
export function memoryBudget(totalMemory: number): number {
  return Math.floor(totalMemory / 2);
}
