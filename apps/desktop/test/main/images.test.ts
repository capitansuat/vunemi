import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadImage, MAX_IMAGE_BYTES, readImageText } from "../../src/main/images.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenami-img-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real 2000×1000 PNG, made with sips from a blank TIFF-free source. */
function bigPng(): string {
  const small = join(dir, "seed.png");
  // A 1×1 PNG, then padded by sips to the size we want.
  writeFileSync(small, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const big = join(dir, "big.png");
  execFileSync("/usr/bin/sips", ["-z", "1000", "2000", small, "--out", big], { stdio: "ignore" });
  return big;
}

describe("loading an image for the model", () => {
  it("scales it to 1280 pixels on the long side, as JPEG", async () => {
    const image = await loadImage(bigPng());
    expect(image?.mime).toBe("image/jpeg");
    const out = join(dir, "out.jpg");
    writeFileSync(out, Buffer.from(image!.base64, "base64"));
    const info = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]).toString();
    expect(info).toMatch(/pixelWidth: 1280/);
    expect(info).toMatch(/pixelHeight: 640/);
  });

  it("refuses what is too big, missing, or not an image", async () => {
    const huge = join(dir, "huge.png");
    writeFileSync(huge, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(await loadImage(huge)).toBeNull();
    expect(await loadImage(join(dir, "missing.png"))).toBeNull();
    const text = join(dir, "notes.png");
    writeFileSync(text, "not a picture");
    expect(await loadImage(text)).toBeNull();
  });
});

describe("reading the text in an image", () => {
  it.skipIf(process.platform !== "darwin")("reads a real picture's text with Vision", async () => {
    const text = join(dir, "note.txt");
    writeFileSync(text, "INVOICE 7429\nblue lantern\n");
    execFileSync("/usr/bin/qlmanage", ["-t", "-s", "1000", "-o", dir, text], { stdio: "ignore" });
    const read = await readImageText(join(dir, "note.txt.png"));
    expect(read).toContain("INVOICE 7429");
    expect(read).toContain("blue lantern");
  }, 120_000);

  it("says null for a file it can't read, rather than an empty answer", async () => {
    const fake = join(dir, "osascript");
    writeFileSync(fake, "#!/bin/sh\necho 'execution error' >&2; exit 1\n", { mode: 0o755 });
    const image = join(dir, "x.png");
    writeFileSync(image, "x");
    expect(await readImageText(image, { osascript: fake })).toBeNull();
    expect(await readImageText(join(dir, "missing.png"))).toBeNull();
  });
});

describe("small pictures of found photos", () => {
  it("are forgotten after a while, newest kept", async () => {
    const { mkdtempSync, mkdirSync, readdirSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { forgetOldPictures } = await import("../../src/main/images.js");
    const dir = mkdtempSync(join(tmpdir(), "vunemi-pictures-"));
    mkdirSync(join(dir, "old"));
    mkdirSync(join(dir, "new"));
    const day = 24 * 60 * 60_000;
    utimesSync(join(dir, "old"), new Date(Date.now() - 40 * day), new Date(Date.now() - 40 * day));
    forgetOldPictures(dir, 30 * day);
    expect(readdirSync(dir)).toEqual(["new"]);
    forgetOldPictures(join(dir, "missing"), day);
  });
});
