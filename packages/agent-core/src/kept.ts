/**
 * Long tool output, kept whole instead of cut. The model is shown the first
 * part and told how to read on: by part, in order, or by searching for the
 * lines it needs. Before this, the middle of a long page was simply gone;
 * putting all of it in the conversation instead costs every later step the
 * time to read it.
 */
import type { ToolDef } from "./tools.js";

interface Kept {
  tool: string;
  text: string;
  /** Characters per part, the first part being what the model was shown. */
  part: number;
}

/** How many outputs are kept, oldest dropped first. */
const MAX_KEPT = 30;
/** Lines a search returns, and how long each may be. */
const MAX_HITS = 30;
const MAX_LINE = 300;

export class KeptOutputs {
  private readonly items = new Map<string, Kept>();
  private next = 1;

  /** Keeps `text` and returns what the model sees instead: its first part and a note. */
  keep(tool: string, text: string, part: number): string {
    const id = `o${this.next++}`;
    this.items.set(id, { tool, text, part });
    while (this.items.size > MAX_KEPT) this.items.delete(this.items.keys().next().value!);
    const parts = Math.ceil(text.length / part);
    const note = `[Showing characters 1–${part.toLocaleString("en-GB")} of ${text.length.toLocaleString("en-GB")}. The whole output is kept as "${id}": output_read with id "${id}" and part 2–${parts} reads the rest in order; output_search finds the lines that contain given words.]`;
    return `${text.slice(0, part)}\n${note}`;
  }

  /** The tool that produced a kept output, for wrapping what's read from it. */
  toolOf(id: string): string | undefined {
    return this.items.get(id)?.tool;
  }

  read(id: string, part: number): string {
    const kept = this.need(id);
    const parts = Math.ceil(kept.text.length / kept.part);
    if (!Number.isInteger(part) || part < 1 || part > parts) throw new Error(`Output "${id}" has parts 1–${parts}.`);
    const more = part < parts ? `\n[Part ${part} of ${parts}. output_read part ${part + 1} continues.]` : `\n[Part ${part} of ${parts}, the last.]`;
    return `${kept.text.slice((part - 1) * kept.part, part * kept.part)}${more}`;
  }

  search(id: string, query: string): string {
    const kept = this.need(id);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new Error("Give one or more words to look for.");
    const hits: string[] = [];
    let at = 0;
    for (const line of kept.text.split("\n")) {
      const lower = line.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        const part = Math.floor(at / kept.part) + 1;
        hits.push(`(part ${part}) ${line.trim().slice(0, MAX_LINE)}`);
        if (hits.length === MAX_HITS) break;
      }
      at += line.length + 1;
    }
    return hits.length ? hits.join("\n") : `No line in "${id}" contains all of: ${words.join(", ")}.`;
  }

  private need(id: string): Kept {
    const kept = this.items.get(id);
    if (!kept) throw new Error(`Output "${id}" is no longer kept. Run the tool that made it again.`);
    return kept;
  }
}

/** The two tools that read kept output. Always offered; they cost ~150 tokens. */
export function keptOutputTools(kept: KeptOutputs): ToolDef[] {
  return [
    {
      name: "output_read",
      description: "Read another part of a long tool output that was kept (its id is in the note under the first part).",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, part: { type: "integer", minimum: 2 } },
        required: ["id", "part"],
      },
      actionClass: "read",
      untrustedOutput: true,
      run: async (a) => kept.read(String(a.id), Number(a.part)),
    },
    {
      name: "output_search",
      description: "Find the lines of a kept tool output that contain all the given words. Cheaper than reading every part.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, query: { type: "string" } },
        required: ["id", "query"],
      },
      actionClass: "read",
      untrustedOutput: true,
      run: async (a) => kept.search(String(a.id), String(a.query)),
    },
  ];
}
