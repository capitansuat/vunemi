/**
 * Pictures on their way to a model that can see. A phone photo is several
 * megabytes and thousands of tokens; scaled to 1280 pixels on the long side
 * it still shows what matters and costs about two thousand. The Mac's own
 * sips does the work, HEIC included, into a temporary file that is removed
 * straight after.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImageData } from "@vunemi/agent-core";

const run = promisify(execFile);

/** Anything larger is not a photo someone meant to show. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SIDE = 1280;

export async function loadImage(path: string, opts: { sips?: string } = {}): Promise<ImageData | null> {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "vunemi-image-"));
  const out = join(dir, "image.jpg");
  try {
    await run(opts.sips ?? "/usr/bin/sips", ["-Z", String(MAX_SIDE), "-s", "format", "jpeg", path, "--out", out], { timeout: 20_000 });
    return { mime: "image/jpeg", base64: readFileSync(out).toString("base64") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The longest text passed on from one picture. */
export const MAX_IMAGE_TEXT = 20_000;
/** Vision prepares its models on first use after a restart; that has taken a minute here. */
const OCR_TIMEOUT_MS = 90_000;

/**
 * Apple's Vision text recognition, reached through the ObjC bridge in a
 * fixed JavaScript for Automation script: no helper change, no permission,
 * nothing leaves the Mac. The path is the script's only argument.
 */
export const RECOGNIZE_TEXT = `function run(argv) {
  ObjC.import("Vision");
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  request.automaticallyDetectsLanguage = true;
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $.NSDictionary.dictionary);
  var error = $();
  if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) throw new Error("Vision could not read the image");
  var results = request.results;
  var lines = [];
  for (var i = 0; i < results.count; i++) {
    var top = results.objectAtIndex(i).topCandidates(1);
    if (top.count > 0) lines.push(ObjC.unwrap(top.objectAtIndex(0).string));
  }
  return JSON.stringify(lines);
}`;

/** Text in a picture, one line per recognised line; "" when there is none, null when it can't be read. */
export async function readImageText(path: string, opts: { osascript?: string } = {}): Promise<string | null> {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const { stdout } = await run(opts.osascript ?? "/usr/bin/osascript", ["-l", "JavaScript", "-e", RECOGNIZE_TEXT, path], {
      timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
    });
    const lines = JSON.parse(stdout) as unknown;
    if (!Array.isArray(lines)) return null;
    return lines.map(String).join("\n").slice(0, MAX_IMAGE_TEXT);
  } catch {
    return null;
  }
}

/** Removes the folders in `dir` last changed more than `ageMs` ago. Never throws. */
export function forgetOldPictures(dir: string, ageMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > ageMs) rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to judge.
    }
  }
}
