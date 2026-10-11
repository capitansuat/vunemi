/** Where the drawing is on a white page, so a picture of it can leave the empty paper out. */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Lighter than this in every channel counts as paper. */
const PAPER = 250;

/**
 * The box around everything that is not white, grown by `margin` and kept
 * inside the picture. `pixels` is four bytes a pixel, row by row; the fourth
 * byte is not looked at. Null when the page is blank or the size is not the
 * buffer's.
 */
export function inkBox(pixels: Uint8Array, width: number, height: number, margin: number): Box | null {
  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) return null;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = row + x * 4;
      if (pixels[at]! >= PAPER && pixels[at + 1]! >= PAPER && pixels[at + 2]! >= PAPER) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  if (right < 0) return null;
  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);
  return { x, y, width: Math.min(width, right + 1 + margin) - x, height: Math.min(height, bottom + 1 + margin) - y };
}
