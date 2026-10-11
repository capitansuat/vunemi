/**
 * Documents, through WordCraft: a Word or PDF file from the Markdown the
 * model writes, and existing documents converted to another format. The
 * first page is shown to the user, so what was made is seen, not described.
 */

import { copyFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { deliver, expectFile, short, show, source, target, type AddonToolDeps } from "./common.js";

const MAX_MARKDOWN = 400_000;
const READS = [".docx", ".doc", ".odt", ".rtf", ".md", ".txt", ".html"] as const;
const WRITES = [".pdf", ".docx", ".odt", ".rtf", ".md", ".txt", ".html"] as const;

export const DOCUMENTS_GUIDE = `Making documents:
- document_make writes a new Word (.docx) or PDF file from Markdown: # headings, **bold**, lists, tables. Write the whole text yourself, in the user's language; it is not a template to fill in later.
- document_convert turns an existing document into another format, for example .docx into .pdf. Neither tool changes or replaces an existing file.
- The user is shown the first page. Layout can differ from Microsoft Word's.`;

export interface DocumentOptions {
  /** The paper the user's region prints on. */
  paper: () => "A4" | "Letter";
}

/** Pages in a document, from the program's own description of it; null when it did not say. */
function pages(info: string): number | null {
  try {
    const n = (JSON.parse(info) as { pages?: unknown }).pages;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

export function documentTools(deps: AddonToolDeps, opts: DocumentOptions): ToolDef[] {
  return [
    {
      name: "document_make",
      description: "Write a new document as a Word (.docx) or PDF file from Markdown: headings, bold, lists, tables.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to save it, ending in .docx or .pdf" },
          markdown: { type: "string", description: "The whole document" },
        },
        required: ["path", "markdown"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.path ?? "")) }),
      async run(a, ctx) {
        const out = target(deps.roots, a.path, [".docx", ".pdf"]);
        const markdown = String(a.markdown ?? "");
        if (!markdown.trim()) throw new Error("markdown is empty: write the document's text.");
        if (markdown.length > MAX_MARKDOWN) throw new Error(`The document is too long (at most ${MAX_MARKDOWN} characters).`);
        return deps.engines("documents", ctx.signal, async (job) => {
          writeFileSync(join(job.dir, "in.md"), markdown);
          expectFile("WordCraft", await job.run(["convert", "in.md", "body.docx"]), join(job.dir, "body.docx"));
          // The program's own page is US Letter.
          const sized = await job.run(["run", "--file", "body.docx", "--cmd", `layout.size=${JSON.stringify({ name: opts.paper() })}`, "--save", "out.docx"]);
          expectFile("WordCraft", sized, join(job.dir, "out.docx"));
          let made = join(job.dir, "out.docx");
          if (extname(out).toLowerCase() === ".pdf") {
            made = join(job.dir, "out.pdf");
            expectFile("WordCraft", await job.run(["convert", "out.docx", "out.pdf"]), made);
          }
          const count = pages((await job.run(["info", "out.docx"])).stdout);
          await job.run(["render", "out.docx", "page.png", "--page", "1", "--scale", "0.8"]);
          deliver(made, out, ctx);
          show(deps, join(job.dir, "page.png"), short(out), ctx);
          return `Created ${short(out)}${count ? `: ${count} ${count === 1 ? "page" : "pages"}` : ""}. The user is shown its first page.`;
        });
      },
    },
    {
      name: "document_convert",
      description: `Convert an existing document to another format, into a new file: for example .docx to .pdf. Reads ${READS.join(", ")}; writes ${WRITES.join(", ")}.`,
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, out: { type: "string", description: "The new file; its ending chooses the format" } },
        required: ["path", "out"],
      },
      actionClass: "write-local",
      preview: async (a) => t("addons.preview.make", { path: short(String(a.out ?? "")) }),
      async run(a, ctx) {
        const from = source(deps.roots, a.path, READS);
        const out = target(deps.roots, a.out, WRITES);
        return deps.engines("documents", ctx.signal, async (job) => {
          const given = `in${extname(from).toLowerCase()}`;
          const made = `out${extname(out).toLowerCase()}`;
          copyFileSync(from, join(job.dir, given));
          expectFile("WordCraft", await job.run(["convert", given, made], { timeoutMs: 180_000 }), join(job.dir, made));
          deliver(join(job.dir, made), out, ctx);
          return `Created ${short(out)} from ${short(from)}.`;
        });
      },
    },
  ];
}
