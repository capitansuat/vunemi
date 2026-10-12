/**
 * Drawing, through VectorCraft: the model writes a picture as SVG and the
 * program renders it. It is how a poster, a card or a simple illustration
 * gets made on this Mac without a picture model.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { deliver, expectFile, short, show, target, tried, type AddonToolDeps } from "./common.js";

const MAX_SVG = 400_000;
const LINKED = "An .svg file cannot have links, <image> or scripts in it. Draw it with shapes and text only.";

export const DRAWING_GUIDE = `Drawing pictures:
- image_draw renders a picture you write as SVG into a new .png, .pdf or .svg file: posters, cards, logos, diagrams, simple illustrations. It draws shapes and text; it cannot make a photograph, and it cannot change an existing picture.
- Save as .svg when the user wants to keep editing the drawing (a logo, an icon); as .png or .pdf otherwise.
- Write one complete <svg> with width, height and viewBox. Use shapes, paths, gradients and text. Fonts: Inter, or a generic family. No <image>, no links to files or the web, no scripts.
- Keep text inside the picture: leave margins, and size it to fit. The user is shown the result.`;

/**
 * What a saved SVG may not carry. The program writes the drawing out again in
 * its own words, which drops scripts and handlers, but it keeps a link as it
 * was given; a drawing that opens something when clicked is not a drawing.
 */
export function inert(svg: string): boolean {
  if (/<script[\s>]|<foreignObject[\s>]|\son[a-z]+\s*=/i.test(svg)) return false;
  return [...svg.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].every((m) => /^(#|data:image\/)/i.test((m[1] ?? m[2] ?? "").trim()));
}

export function drawingTools(deps: AddonToolDeps): ToolDef[] {
  const asked = (a: Record<string, unknown>) => {
    const out = target(deps.roots, a.path, [".png", ".pdf", ".svg"]);
    const svg = String(a.svg ?? "").trim();
    if (!/<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error("svg must be one complete <svg>…</svg> document.");
    if (svg.length > MAX_SVG) throw new Error(`The SVG is too long (at most ${MAX_SVG} characters).`);
    if (extname(out).toLowerCase() === ".svg" && !inert(svg)) throw new Error(LINKED);
    return { out, svg };
  };
  return [
    {
      name: "image_draw",
      description: "Draw a picture (poster, card, logo, diagram, simple illustration) by writing it as SVG; saved as a new .png, .pdf or .svg file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to save it, ending in .png, .pdf or .svg" },
          svg: { type: "string", description: "A complete <svg> document with width, height and viewBox" },
        },
        required: ["path", "svg"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.path ?? "")) }),
      check: (a) => tried(() => asked(a)),
      async run(a, ctx) {
        const { out, svg } = asked(a);
        return deps.engines("drawing", ctx.signal, async (job) => {
          writeFileSync(join(job.dir, "in.svg"), svg);
          const picture = join(job.dir, "out.png");
          expectFile("VectorCraft", await job.run(["convert", "in.svg", "out.png"]), picture);
          let made = picture;
          const kind = extname(out).toLowerCase();
          if (kind !== ".png") {
            // An SVG is saved as the program writes it, not as the model did.
            made = join(job.dir, `out${kind}`);
            expectFile("VectorCraft", await job.run(["convert", "in.svg", `out${kind}`]), made);
            if (kind === ".svg") {
              const written = readFileSync(made, "utf8");
              if (!inert(written)) throw new Error(LINKED);
              // The program titles the drawing after the file it read, which here is the job's own name for it.
              writeFileSync(made, written.replace("<title>in.svg</title>", `<title>${basename(out, ".svg").replace(/[<>&]/g, "")}</title>`));
            }
          }
          deliver(made, out, ctx);
          show(deps, picture, short(out), ctx);
          return `Created ${short(out)}. The user is shown the picture.`;
        });
      },
    },
  ];
}
