/**
 * Presentations, through DeckCraft: a new deck from the slides the model
 * lists. Each slide is a title with either lines of text or one chart; the
 * slides are shown to the user as they came out.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { deliver, expectFile, short, showAll, target, text, tried, type AddonToolDeps } from "./common.js";

const MAX_SLIDES = 60;
const MAX_LINES = 12;
const LAYOUTS = ["title", "titleAndContent", "sectionHeader", "titleOnly"] as const;
const CHARTS = ["column", "bar", "line", "pie"] as const;
export const THEMES = ["DeckCraft", "Harbor", "Ember", "Meadow", "Nocturne", "Paper", "Coral Reef", "Slate"] as const;
/** Where a chart sits on a 960 by 540 slide, clear of the title. */
const CHART_RECT = [80, 150, 800, 340];

export const SLIDES_GUIDE = `Making presentations:
- slides_make makes a new .pptx file; it cannot change an existing one. Give every slide in one call, in order.
- Layouts: title (the opening slide; body is the subtitle), sectionHeader, titleAndContent (title and a few short lines), titleOnly (title, and a chart if given). A slide has body lines or a chart, not both.
- Keep lines short, at most six a slide, with no bullet characters: the slide adds them. Chart values are numbers you were given or read, never guesses.
- The user is shown the slides. Layout can differ from PowerPoint's.`;

interface Chart {
  type: string;
  categories: string[];
  series: { name: string; values: number[] }[];
}
interface Slide {
  layout: string;
  title: string;
  body: string[];
  notes: string;
  chart?: Chart;
}

/** A line as the model wrote it, without the bullet it should not have typed. */
const line = (raw: unknown): string => text(raw, 300).replace(/^\s*(?:[•·▪◦‣*]|[-–—](?=\s))\s*/u, "").trim();

function chartOf(input: unknown): Chart | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as { type?: unknown; categories?: unknown; series?: unknown };
  const categories = Array.isArray(raw.categories) ? raw.categories.slice(0, 40).map((c) => text(c, 80)) : [];
  const series = (Array.isArray(raw.series) ? raw.series : []).slice(0, 12).map((s) => {
    const one = (s ?? {}) as { name?: unknown; values?: unknown };
    const values = (Array.isArray(one.values) ? one.values : []).slice(0, categories.length).map(Number);
    if (values.some((v) => !Number.isFinite(v))) throw new Error("Chart values must be numbers.");
    return { name: text(one.name, 80), values };
  });
  if (categories.length === 0 || series.length === 0) throw new Error("A chart needs categories and at least one series of numbers.");
  return { type: CHARTS.find((kind) => kind === raw.type) ?? "column", categories, series };
}

function slidesOf(input: unknown): Slide[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("slides must be a list with at least one slide.");
  if (input.length > MAX_SLIDES) throw new Error(`At most ${MAX_SLIDES} slides.`);
  return input.map((raw, index): Slide => {
    const one = (raw ?? {}) as { layout?: unknown; title?: unknown; body?: unknown; notes?: unknown; chart?: unknown };
    const lines = Array.isArray(one.body) ? one.body : typeof one.body === "string" ? one.body.split("\n") : [];
    const chart = chartOf(one.chart);
    const body = chart ? [] : lines.map(line).filter(Boolean).slice(0, MAX_LINES);
    const asked = LAYOUTS.find((kind) => kind === one.layout);
    const layout = chart ? "titleOnly" : asked ?? (index === 0 ? "title" : body.length > 0 ? "titleAndContent" : "titleOnly");
    return { layout, title: text(one.title, 200).trim(), body, notes: text(one.notes, 2_000).trim(), ...(chart && { chart }) };
  });
}

/** The program's commands for a deck, as its command-line arguments. */
export function deckArgs(slides: Slide[], theme: string | undefined): string[] {
  const cmd = (id: string, params: unknown): string[] => ["--cmd", `${id}=${JSON.stringify(params)}`];
  const args = ["run", ...cmd("file.new", { blank: true, ...(theme && { theme }) })];
  for (const slide of slides) {
    args.push(...cmd("slide.new", { layout: slide.layout, title: slide.title, ...(slide.body.length > 0 && { body: slide.body.join("\n") }) }));
    if (slide.chart) {
      args.push(...cmd("insert.chart", { ...slide.chart, rect: CHART_RECT }));
      // The slide's own title names the chart; the program's placeholder title is taken off.
      args.push(...cmd("chart.options", { title: null }));
    }
    if (slide.notes) args.push(...cmd("slide.notes", { text: slide.notes }));
  }
  return [...args, "--save", "out.pptx"];
}

export function slideTools(deps: AddonToolDeps): ToolDef[] {
  const asked = (a: Record<string, unknown>) => ({ out: target(deps.roots, a.path, [".pptx"]), slides: slidesOf(a.slides), theme: THEMES.find((name) => name === a.theme) });
  return [
    {
      name: "slides_make",
      description: "Make a new PowerPoint file (.pptx). Each slide has a title and either body lines or one chart.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ends in .pptx" },
          theme: { type: "string", enum: [...THEMES] },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                layout: { type: "string", enum: [...LAYOUTS] },
                title: { type: "string" },
                body: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
                chart: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: [...CHARTS] },
                    categories: { type: "array", items: { type: "string" } },
                    series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } } },
                  },
                },
              },
              required: ["title"],
            },
          },
        },
        required: ["path", "slides"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.path ?? "")) }),
      check: (a) => tried(() => asked(a)),
      async run(a, ctx) {
        const { out, slides, theme } = asked(a);
        return deps.engines("slides", ctx.signal, async (job) => {
          const made = join(job.dir, "out.pptx");
          expectFile("DeckCraft", await job.run(deckArgs(slides, theme)), made);
          await job.run(["render", "out.pptx", "--all", "--scale", "0.5", "shown"]);
          deliver(made, out, ctx);
          const shown = join(job.dir, "shown");
          const pictures = existsSync(shown) ? readdirSync(shown).filter((name) => name.endsWith(".png")).sort().map((name) => join(shown, name)) : [];
          showAll(deps, pictures, short(out), ctx);
          const charts = slides.filter((slide) => slide.chart).length;
          return `Created ${short(out)}: ${slides.length} ${slides.length === 1 ? "slide" : "slides"}${charts ? `, ${charts} with a chart` : ""}. The user is shown the slides.`;
        });
      },
    },
  ];
}
