/**
 * Photo editing, through PhotoCraft: one tool with a fixed set of changes,
 * applied in one order: crop, turn, flip, resize, then the colour changes.
 * The picture it was given is never touched; the result is a new file,
 * shown to the user.
 */

import { copyFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { EngineJob } from "../jobs.js";
import { deliver, expectFile, paths, said, short, show, source, target, type AddonToolDeps } from "./common.js";

const ENGINE = "PhotoCraft";
const READS = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".heic", ".psd"] as const;
const WRITES = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".psd"] as const;
const MAX_SIDE = 12_000;
const SLOW_MS = 180_000;

export const PHOTO_GUIDE = `Editing pictures:
- photo_edit makes a changed copy of a picture: crop, rotate, flip, resize, brightness, contrast, saturation, automatic tone, sharpen, blur. With no change it only converts the format, which the new file's ending chooses (.jpg, .png, .webp, .tif, .psd).
- Crop by shape with crop.ratio ("1:1", "16:9", "4:5": the middle of the picture is kept) or by exact pixels with x, y, width, height. Resize by width or height alone to keep the shape.
- brightness, contrast and saturation go from -100 to 100; 0 changes nothing. Small steps (10 to 30) look natural.
- It cannot remove objects or backgrounds, and cannot make a picture from words. The original is never changed. The result says the picture's size before and after.`;

interface Size {
  width: number;
  height: number;
}

async function sizeOf(job: EngineJob, file: string): Promise<Size> {
  const result = await job.run(["info", file, "--compact"]);
  try {
    const info = JSON.parse(result.stdout) as { width?: unknown; height?: unknown };
    const size = { width: Number(info.width), height: Number(info.height) };
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    // Said below.
  }
  throw new Error(t("apps.error.failed", { app: ENGINE, detail: said(result) }));
}

const whole = (value: unknown): number | null => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value)) : null);
const level = (value: unknown): number => Math.max(-100, Math.min(100, whole(value) ?? 0));

/** The box a crop keeps, inside a picture of this size. */
export function cropBox(input: unknown, size: Size): { x: number; y: number; width: number; height: number } | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { ratio?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  if (raw.ratio !== undefined && raw.ratio !== "") {
    const match = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(String(raw.ratio).trim());
    const ratio = match ? Number(match[1]) / Number(match[2]) : 0;
    if (!ratio || ratio > 20 || ratio < 0.05) throw new Error('crop.ratio must be like "1:1" or "16:9".');
    const width = Math.min(size.width, Math.round(size.height * ratio));
    const height = Math.min(size.height, Math.round(width / ratio));
    return { x: Math.round((size.width - width) / 2), y: Math.round((size.height - height) / 2), width, height };
  }
  const [x, y, width, height] = [whole(raw.x) ?? 0, whole(raw.y) ?? 0, whole(raw.width), whole(raw.height)];
  if (width === null || height === null) throw new Error("crop needs ratio, or width and height in pixels (with x and y from the top left).");
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > size.width || y + height > size.height) {
    throw new Error(`The crop is outside the picture, which is ${size.width} by ${size.height} pixels.`);
  }
  return { x, y, width, height };
}

/** The program's commands for the changes asked for, in the order they are applied. */
export function photoArgs(a: Record<string, unknown>, size: Size): { args: string[]; did: string[] } {
  const args: string[] = [];
  const did: string[] = [];
  const cmd = (id: string, params?: Record<string, unknown>) => args.push("--cmd", id, ...(params ? ["--params", JSON.stringify(params)] : []));
  let now = { ...size };

  const box = cropBox(a.crop, now);
  if (box) {
    cmd("image.crop", box);
    now = { width: box.width, height: box.height };
    did.push(`cropped to ${box.width} by ${box.height}`);
  }
  const turn = whole(a.rotate);
  if (turn) {
    const id = ({ 90: "image.imageRotation.90cw", 180: "image.imageRotation.180", 270: "image.imageRotation.90ccw" } as Record<number, string>)[turn];
    if (!id) throw new Error("rotate must be 90, 180 or 270 (clockwise).");
    cmd(id);
    if (turn !== 180) now = { width: now.height, height: now.width };
    did.push(`rotated ${turn}°`);
  }
  if (a.flip === "horizontal" || a.flip === "vertical") {
    cmd(a.flip === "horizontal" ? "image.imageRotation.flipCanvasHorizontal" : "image.imageRotation.flipCanvasVertical");
    did.push(`flipped ${a.flip}`);
  }
  const resize = (a.resize ?? {}) as { width?: unknown; height?: unknown };
  let [width, height] = [whole(resize.width), whole(resize.height)];
  if (width !== null || height !== null) {
    // One side given: the other follows, so the picture keeps its shape.
    width ??= Math.max(1, Math.round((height! * now.width) / now.height));
    height ??= Math.max(1, Math.round((width * now.height) / now.width));
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`A side must be between 1 and ${MAX_SIDE} pixels.`);
    cmd("image.imageSize", { width, height });
    now = { width, height };
    did.push(`resized to ${width} by ${height}`);
  }
  if (a.auto === true) {
    cmd("image.autoTone");
    did.push("automatic tone");
  }
  const [brightness, contrast, saturation] = [level(a.brightness), level(a.contrast), level(a.saturation)];
  if (brightness !== 0 || contrast !== 0) {
    // The program's own ranges: brightness -150 to 150, contrast -50 to 100.
    cmd("image.adjustments.brightnessContrast", { brightness: Math.round(brightness * 1.5), contrast: contrast < 0 ? Math.round(contrast / 2) : contrast });
    did.push(`brightness ${brightness}, contrast ${contrast}`);
  }
  if (saturation !== 0) {
    cmd("image.adjustments.vibrance", { saturation });
    did.push(`saturation ${saturation}`);
  }
  if (a.sharpen === true) {
    cmd("filter.sharpen.unsharpMask", { amount: 80, radius: 1 });
    did.push("sharpened");
  }
  const blur = Number(a.blur);
  if (Number.isFinite(blur) && blur > 0) {
    cmd("filter.blur.gaussianBlur", { radius: Math.min(100, blur) });
    did.push(`blurred ${Math.min(100, blur)}`);
  }
  return { args, did };
}

export function photoTools(deps: AddonToolDeps): ToolDef[] {
  // -100 to 100; the guide says so, once, instead of each of the three.
  const amount = { type: "integer" };
  return [
    {
      name: "photo_edit",
      description: "Make a changed copy of a picture: crop, rotate, flip, resize, adjust, or just convert the format (the new file's ending chooses it).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          out: { type: "string", description: "The new file: .jpg, .png, .webp, .tif or .psd" },
          crop: { type: "object", properties: { ratio: { type: "string", description: "e.g. 1:1, 16:9" }, x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } } },
          rotate: { type: "integer", enum: [90, 180, 270] },
          flip: { type: "string", enum: ["horizontal", "vertical"] },
          resize: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
          auto: { type: "boolean", description: "Automatic tone" },
          brightness: amount,
          contrast: amount,
          saturation: amount,
          sharpen: { type: "boolean" },
          blur: { type: "number" },
        },
        required: ["path", "out"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.out ?? "")) }),
      check: (a) => paths(() => (source(deps.roots, a.path, READS), target(deps.roots, a.out, WRITES))),
      async run(a, ctx) {
        const from = source(deps.roots, a.path, READS);
        const out = target(deps.roots, a.out, WRITES);
        return deps.engines("photo", ctx.signal, async (job) => {
          const given = `in${extname(from).toLowerCase()}`;
          const made = `out${extname(out).toLowerCase()}`;
          copyFileSync(from, join(job.dir, given));
          const before = await sizeOf(job, given);
          const { args, did } = photoArgs(a, before);
          const lossy = /\.(jpe?g|webp)$/.test(made);
          const result = args.length > 0
            ? await job.run(["run", given, ...args, "--out", made, ...(lossy ? ["--quality", "90"] : [])], { timeoutMs: SLOW_MS })
            : await job.run(["convert", given, made, ...(lossy ? ["--quality", "90"] : [])], { timeoutMs: SLOW_MS });
          expectFile(ENGINE, result, join(job.dir, made));
          const after = await sizeOf(job, made);
          // A small copy for the window, whatever format was asked for.
          const scale = Math.min(1, 900 / Math.max(after.width, after.height));
          await job.run(["run", made, "--cmd", "image.imageSize", "--params", JSON.stringify({ width: Math.max(1, Math.round(after.width * scale)), height: Math.max(1, Math.round(after.height * scale)) }), "--out", "shown.png"]);
          deliver(join(job.dir, made), out, ctx);
          show(deps, join(job.dir, "shown.png"), short(out), ctx);
          return `Created ${short(out)} from ${short(from)}: ${did.length > 0 ? did.join(", ") : "format converted"}. Before: ${before.width} by ${before.height} pixels; now: ${after.width} by ${after.height}. The user is shown the result.`;
        });
      },
    },
  ];
}
