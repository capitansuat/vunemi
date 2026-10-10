/**
 * Putting a shortcut Vunemi built into the user's Shortcuts.
 *
 * The file comes from the block menu's compiler (shortcut-builder). macOS
 * only imports a shortcut that is signed, and signing is Apple's: the
 * `shortcuts sign` command sends the file to Apple's servers, which is why
 * the summary says so before anything is built. What is sent are the steps;
 * the blocks hold no data of the user's.
 *
 * Vunemi does not add the shortcut. It opens the signed file, Shortcuts asks
 * "Add Shortcut?", and the user answers. Whether they did is read from the
 * list of their shortcuts' names.
 *
 * When the file can't be made or signed (no network, or a macOS whose
 * Shortcuts no longer reads what is written here), Shortcuts is opened on a
 * new, empty shortcut and the window lists the steps for adding by hand.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileShortcut, plistXml, ShortcutRefused, validShortcut, type ShortcutBuilt } from "@vunemi/apps";

const SHORTCUTS = "/usr/bin/shortcuts";
const PLUTIL = "/usr/bin/plutil";
const OPEN = "/usr/bin/open";
/** Signing waits on Apple's servers. */
const SIGN_TIMEOUT_MS = 60_000;
/** How long the user has to answer "Add Shortcut?" before Vunemi stops looking. */
const ANSWER_MS = 180_000;
const LOOK_EVERY_MS = 2_000;

export interface ShortcutInstallerOptions {
  /** Where the files are made; the same shortcut is written over, not piled up. */
  dir: string;
  /** Replaced in tests. */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  uuid?: () => string;
  answerMs?: number;
  lookEveryMs?: number;
}

const run = (file: string, args: string[], timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n")[0]!.slice(0, 200)));
      else resolve(stdout);
    });
  });

export class ShortcutInstaller {
  private readonly exec: NonNullable<ShortcutInstallerOptions["exec"]>;

  constructor(private readonly opts: ShortcutInstallerOptions) {
    this.exec = opts.exec ?? run;
  }

  /** The names of the user's shortcuts. */
  async names(): Promise<string[]> {
    const out = await this.exec(SHORTCUTS, ["list"], 15_000);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Builds, signs and opens a shortcut, and waits for the user's answer in
   * Shortcuts. A draft the menu refuses throws: that is a mistake of whoever
   * made it, not something to work around by hand.
   */
  async install(raw: unknown, signal?: AbortSignal): Promise<ShortcutBuilt> {
    const { name } = validShortcut(raw);
    const have = (): Promise<boolean> => this.names().then((names) => names.includes(name), () => false);
    if (await have()) return { state: "exists", name };
    try {
      const { plist } = compileShortcut(raw, this.opts.uuid ?? randomUUID);
      const unsigned = join(this.opts.dir, "unsigned");
      mkdirSync(unsigned, { recursive: true, mode: 0o700 });
      chmodSync(this.opts.dir, 0o700);
      const xml = join(unsigned, `${name}.xml`);
      const draft = join(unsigned, `${name}.shortcut`);
      const signed = join(this.opts.dir, `${name}.shortcut`);
      writeFileSync(xml, plistXml(plist), { mode: 0o600 });
      await this.exec(PLUTIL, ["-convert", "binary1", "-o", draft, "--", xml], 15_000);
      await this.exec(SHORTCUTS, ["sign", "--mode", "anyone", "--input", draft, "--output", signed], SIGN_TIMEOUT_MS);
      await this.exec(OPEN, ["-a", "Shortcuts", "--", signed], 15_000);
    } catch (err) {
      if (err instanceof ShortcutRefused) throw err;
      await this.exec(OPEN, ["shortcuts://create-shortcut"], 15_000).catch(() => {});
      return { state: "failed", name, reason: err instanceof Error ? err.message : String(err) };
    }
    const until = Date.now() + (this.opts.answerMs ?? ANSWER_MS);
    while (Date.now() < until && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.lookEveryMs ?? LOOK_EVERY_MS));
      if (await have()) return { state: "added", name };
    }
    return { state: "notAdded", name };
  }
}
