/**
 * Long tool output kept in the work archive, for the conversation that
 * produced it: still there after a restart, never read from another
 * conversation.
 */
import { keptNote, readPart, searchLines, type OutputKeeper } from "@vunemi/agent-core";
import type { WorkStore } from "./store.js";

export class ArchivedOutputs implements OutputKeeper {
  constructor(
    private readonly store: WorkStore,
    /** The conversation now open; asked at each call, since the user switches. */
    private readonly conversation: () => string,
  ) {}

  keep(tool: string, text: string, part: number): string {
    const id = this.store.addOutput(this.conversation(), tool, text, part);
    return `${text.slice(0, part)}\n${keptNote(id, part, text.length)}`;
  }

  read(id: string, part: number): string {
    const kept = this.need(id);
    return readPart(kept.text, kept.part, id, part);
  }

  search(id: string, query: string): string {
    const kept = this.need(id);
    return searchLines(kept.text, kept.part, id, query);
  }

  toolOf(id: string): string | undefined {
    return this.store.outputTool(this.conversation(), id);
  }

  private need(id: string): { tool: string; text: string; part: number } {
    const kept = this.store.output(this.conversation(), id);
    if (!kept) throw new Error(`Output "${id}" is no longer kept. Run the tool that made it again.`);
    return kept;
  }
}
