/** Finding the drawing on a white page. */
import { describe, expect, it } from "vitest";
import { inkBox } from "../../src/main/ink-box.js";

/** A white page with the given pixels darkened. */
function page(width: number, height: number, dark: [number, number][]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y] of dark) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return pixels;
}

describe("inkBox", () => {
  it("boxes what was drawn, with the margin", () => {
    expect(inkBox(page(40, 30, [[10, 8], [19, 14]]), 40, 30, 2)).toEqual({ x: 8, y: 6, width: 14, height: 11 });
  });

  it("keeps the box inside the picture", () => {
    expect(inkBox(page(40, 30, [[1, 0], [39, 29]]), 40, 30, 5)).toEqual({ x: 0, y: 0, width: 40, height: 30 });
  });

  it("takes near-white as paper", () => {
    const pixels = page(10, 10, [[4, 4]]);
    pixels.fill(252, 0, 4);
    expect(inkBox(pixels, 10, 10, 0)).toEqual({ x: 4, y: 4, width: 1, height: 1 });
  });

  it("has no box for a blank page or a buffer of another size", () => {
    expect(inkBox(page(10, 10, []), 10, 10, 4)).toBeNull();
    expect(inkBox(page(10, 10, [[1, 1]]), 20, 10, 4)).toBeNull();
  });
});
