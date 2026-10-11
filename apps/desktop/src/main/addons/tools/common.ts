/**
 * What every add-on tool does around the program: checks the paths the model
 * gave against the user's open folders, hands files in and out of the job
 * folder, and says plainly when the program failed.
 */

import { randomBytes } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { ToolContext } from "@vunemi/agent-core";
import type { Roots } from "@vunemi/files";
import { t } from "@vunemi/i18n";
import type { Engines } from "../jobs.js";
import type { SandboxResult } from "../sandbox.js";

export interface AddonToolDeps {
  engines: Engines;
  roots: Roots;
  /** Vunemi's folder of pictures the window may show. */
  shotDir: string;
  /** Draws HTML a program wrote as a PNG, in a window with no scripts and no network. */
  picture?: (html: string, signal: AbortSignal) => Promise<Uint8Array>;
}

export const short = (path: string): string => path.replace(homedir(), "~");

/** A file to make: inside an open folder, of the right kind, and not there yet. */
export function target(roots: Roots, input: unknown, extensions: readonly string[]): string {
  const path = roots.resolve(String(input ?? ""), "write");
  if (!extensions.includes(extname(path).toLowerCase())) throw new Error(`The file name must end in ${extensions.join(" or ")}.`);
  if (existsSync(path)) throw new Error(t("files.exists", { path: short(path) }));
  return path;
}

/** A file to work from: one the user's folders allow reading, of the right kind. */
export function source(roots: Roots, input: unknown, extensions: readonly string[]): string {
  const path = roots.resolve(String(input ?? ""), "read");
  if (!extensions.includes(extname(path).toLowerCase())) throw new Error(`Expected a ${extensions.join(" or ")} file.`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(t("files.notFound", { path: short(path) }));
  return path;
}

/**
 * A tool's check before any card: the paths are tried first, so the user is
 * never asked to approve a file that could not be read or written anyway (a
 * folder that is not open, a name already taken). The reason goes back to
 * the model, which can then ask with a path that works.
 */
export function paths(tryThem: () => unknown): string | null {
  try {
    tryThem();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Takes a finished file out of the job folder. Never replaces a file that appeared meanwhile. */
export function deliver(made: string, to: string, ctx: ToolContext): void {
  try {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(made, to, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(t("files.exists", { path: short(to) }));
    throw error;
  }
  ctx.produced?.({ kind: "file", path: to });
}

/** Shows the user a picture the program rendered. */
export function show(deps: AddonToolDeps, png: string, label: string, ctx: ToolContext): void {
  if (!existsSync(png)) return;
  const dir = join(deps.shotDir, "addons");
  mkdirSync(dir, { recursive: true });
  const kept = join(dir, `${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  copyFileSync(png, kept);
  ctx.attach({ kind: "image", path: kept, label });
}

/** Shows several pictures of one thing, such as a deck's slides, as tiles when the card can. */
export function showAll(deps: AddonToolDeps, pngs: readonly string[], label: string, ctx: ToolContext): void {
  const found = pngs.filter((png) => existsSync(png)).slice(0, 24);
  if (found.length === 0) return;
  if (!ctx.gallery || found.length === 1) return show(deps, found[0]!, label, ctx);
  const dir = join(deps.shotDir, "addons");
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  ctx.gallery(
    found.map((png, index) => {
      const kept = join(dir, `${stamp}-${String(index + 1).padStart(2, "0")}.png`);
      copyFileSync(png, kept);
      return { kind: "image" as const, path: kept, label: `${label} · ${index + 1}` };
    }),
  );
}

/** The program's own last words, short enough to put in front of a person. */
export function said(result: SandboxResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ").trim();
  return text.slice(-300) || `exit ${result.code}`;
}

/** Throws unless the program finished and left a file with something in it. */
export function expectFile(engine: string, result: SandboxResult, path: string): void {
  const whole = existsSync(path) && statSync(path).size > 0;
  if (result.code !== 0 || !whole) throw new Error(t("apps.error.failed", { app: engine, detail: said(result) }));
}

export const text = (value: unknown, max: number): string => String(value ?? "").slice(0, max);
