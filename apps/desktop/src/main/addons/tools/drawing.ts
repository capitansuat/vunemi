/**
 * Drawing, through VectorCraft: the model writes a picture as SVG and the
 * program renders it. It is how a poster, a card or a simple illustration
 * gets made on this Mac without a picture model.
 */

import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { deliver, expectFile, paths, short, show, target, type AddonToolDeps } from "./common.js";

const MAX_SVG = 400_000;

export const DRAWING_GUIDE = `Drawing pictures:
- image_draw renders a picture you write as SVG into a new .png or .pdf file: posters, cards, logos, diagrams, simple illustrations. It draws shapes and text; it cannot make a photograph, and it cannot change an existing picture.
- Write one complete <svg> with width, height and viewBox. Use shapes, paths, gradients and text. Fonts: Inter, or a generic family. No <image>, no links to files or the web, no scripts.
- Keep text inside the picture: leave margins, and size it to fit. The user is shown the result.`;

export function drawingTools(deps: AddonToolDeps): ToolDef[] {
  return [
    {
      name: "image_draw",
      description: "Draw a picture (poster, card, logo, diagram, simple illustration) by writing it as SVG; saved as a new .png or .pdf file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to save it, ending in .png or .pdf" },
          svg: { type: "string", description: "A complete <svg> document with width, height and viewBox" },
        },
        required: ["path", "svg"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.path ?? "")) }),
      check: (a) => paths(() => target(deps.roots, a.path, [".png", ".pdf"])),
      async run(a, ctx) {
        const out = target(deps.roots, a.path, [".png", ".pdf"]);
        const svg = String(a.svg ?? "").trim();
        if (!/<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error("svg must be one complete <svg>…</svg> document.");
        if (svg.length > MAX_SVG) throw new Error(`The SVG is too long (at most ${MAX_SVG} characters).`);
        return deps.engines("drawing", ctx.signal, async (job) => {
          writeFileSync(join(job.dir, "in.svg"), svg);
          const picture = join(job.dir, "out.png");
          expectFile("VectorCraft", await job.run(["convert", "in.svg", "out.png"]), picture);
          let made = picture;
          if (extname(out).toLowerCase() === ".pdf") {
            made = join(job.dir, "out.pdf");
            expectFile("VectorCraft", await job.run(["convert", "in.svg", "out.pdf"]), made);
          }
          deliver(made, out, ctx);
          show(deps, picture, short(out), ctx);
          return `Created ${short(out)}. The user is shown the picture.`;
        });
      },
    },
  ];
}
