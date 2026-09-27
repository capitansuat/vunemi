/**
 * Shadow copies: the cheap undo.
 *
 * Before the agent overwrites or moves a file, the old bytes are copied
 * aside. The activity log's "Geri al" then just puts them back. This is what
 * makes a local model's mistakes survivable — the plan's whole stance is that
 * the agent will sometimes be wrong, so being wrong has to be cheap.
 *
 * Copies are kept for a few days and then swept, because a shadow folder that
 * grows forever is its own kind of problem.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How long a shadow copy stays around after the change it protects. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
/** Bigger than this and copying costs more than the undo is worth. */
const MAX_SHADOW_BYTES = 64 * 1024 * 1024;

export class Shadow {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.sweep();
  }

  /**
   * Keeps the current contents of `path`, if it has any. Returns where they
   * went, or null when there was nothing to keep (a new file) or the file was
   * too big to copy.
   */
  keep(path: string): string | null {
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      size = stat.size;
    } catch {
      return null; // doesn't exist yet: undo means deleting it again
    }
    if (size > MAX_SHADOW_BYTES) return null;

    const copy = join(this.dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base(path)}`);
    copyFileSync(path, copy);
    return copy;
  }

  /** Puts kept contents back where they came from. */
  restore(copy: string, path: string): void {
    copyFileSync(copy, path);
  }

  /** Drops copies older than a week; called on start, so it costs nothing later. */
  private sweep(): void {
    const cutoff = Date.now() - KEEP_MS;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(this.dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
}

/** A file name safe to use inside the shadow folder. */
function base(path: string): string {
  return (path.split("/").pop() ?? "file").replace(/[^\w.\-ğüşıöçĞÜŞİÖÇ]/g, "_").slice(0, 64);
}
