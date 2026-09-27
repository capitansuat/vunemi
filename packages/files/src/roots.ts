/**
 * Where the agent may look, and how a path is proven to be there.
 *
 * The rule is a whitelist of folders the user opted into — Desktop,
 * Documents, Downloads by default — and every path is resolved to its real
 * location before it is judged. That matters more than it sounds: `..`,
 * symlinks and a `~` that isn't the user's home are all ways to name a file
 * inside an allowed folder and read one outside it. Resolving first, judging
 * second, closes all three at once.
 *
 * Hidden files stay out. They are where credentials live (`.ssh`, `.aws`,
 * `.env`), the agent has no business reading them, and a task that genuinely
 * needs one is a task the user should do themselves.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { t } from "@ocak/i18n";

/**
 * Finder shows these folders with Turkish names while the disk keeps the
 * English ones. Someone who says "Belgeler" — and a model that repeats them
 * — means ~/Documents, and refusing that is pedantry, not safety: the alias
 * only ever resolves to a folder that is already open.
 */
const ALIASES: Record<string, string> = {
  belgeler: "Documents",
  dokumanlar: "Documents",
  indirilenler: "Downloads",
  indirmeler: "Downloads",
  masaustu: "Desktop",
};

/** Turkish, without its diacritics, so "Masaüstü" and "masaustu" are one word. */
function plain(segment: string): string {
  return segment
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** The Finder name for a folder we opened, when it has one. */
export function localName(path: string): string | null {
  const base = path.split(sep).pop() ?? "";
  const match = Object.entries(ALIASES).find(([, english]) => english === base);
  return match ? TURKISH[match[1]] ?? null : null;
}

const TURKISH: Record<string, string> = { Documents: "Belgeler", Downloads: "İndirilenler", Desktop: "Masaüstü" };

export class PathRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRefused";
  }
}

/** The folders a fresh install opens up. Everything else is closed. */
export function defaultRoots(home = homedir()): string[] {
  return [join(home, "Desktop"), join(home, "Documents"), join(home, "Downloads")];
}

export class Roots {
  private readonly base: string[];
  /** Project folders the user chose, and the one the current conversation works in. */
  private projects: string[] = [];
  private active: string | null = null;
  /** Single files the user handed over by attaching them. Read-only, and only themselves. */
  private readonly granted = new Set<string>();

  constructor(roots: readonly string[] = defaultRoots()) {
    // Resolve the roots themselves too: on macOS /tmp and even the home
    // directory can be symlinks, and a root that isn't real can't be matched.
    this.base = roots.map((r) => realOrPlanned(resolve(r)));
  }

  /**
   * The open folders. The current project's comes first, so a bare file
   * name means a file in the project.
   */
  list(): string[] {
    const rest = [...this.base, ...this.projects].filter((r) => r !== this.active);
    return [...new Set(this.active ? [this.active, ...rest] : rest)];
  }

  /** The current project's folder, if the conversation has one. */
  get project(): string | null {
    return this.active;
  }

  /**
   * The folders of the user's projects, each opened by the user picking it,
   * and which one the current conversation works in (null: none).
   */
  setProjects(folders: readonly string[], active: string | null): void {
    this.projects = folders.map((f) => realOrPlanned(resolve(f)));
    this.active = active ? realOrPlanned(resolve(active)) : null;
  }

  /**
   * Turns whatever the model wrote into a real path inside an allowed folder,
   * or refuses with a sentence the user can read. Relative paths are taken
   * from the first root, so "notlar.txt" means something sensible.
   */
  resolve(input: string, access: "read" | "write" = "write"): string {
    const raw = String(input ?? "").trim();
    if (!raw) throw new PathRefused(t("files.pathNeeded"));
    if (raw.includes("\0")) throw new PathRefused(t("files.pathInvalid"));

    const expanded = raw === "~" || raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(1)) : raw;
    const named = withAliases(expanded);
    // A bare name belongs to the first open folder; a Finder name like
    // "Belgeler/rapor.txt" names a folder in the home directory.
    const roots = this.list();
    const base = named === expanded ? (roots[0] ?? homedir()) : homedir();
    const absolute = isAbsolute(named) ? normalize(named) : join(base, named);
    const real = realOrPlanned(absolute);

    // The deepest match: a project inside Documents is judged as the project.
    const root = roots.filter((r) => real === r || real.startsWith(r + sep)).sort((a, b) => b.length - a.length)[0];
    if (!root && access === "read" && this.granted.has(real)) return real;
    if (!root) {
      throw new PathRefused(
        t("files.outside", { path: raw, roots: roots.join(", ") }),
      );
    }
    if (hidden(relative(root, real))) {
      throw new PathRefused(t("files.hidden", { path: raw }));
    }
    return real;
  }

  /**
   * A file the user attached to a message. The agent may then read that one
   * file wherever it is — not write it, not list or read what is next to it.
   * Picking a file is the user saying "look at this"; it opens nothing else.
   * Hidden files and anything inside a hidden folder (.ssh, .env) are still
   * refused: those are where secrets live, and a drag can miss its target.
   */
  grant(input: string): string {
    const real = realOrPlanned(resolve(String(input ?? "")));
    let file: boolean;
    try {
      file = statSync(real).isFile();
    } catch {
      throw new PathRefused(t("files.notFound", { path: input }));
    }
    if (!file) throw new PathRefused(t("files.grantNotFile", { name: parse(real).base }));
    const home = homedir();
    const inside = real.startsWith(home + sep) ? relative(home, real) : parse(real).base;
    if (hidden(inside)) throw new PathRefused(t("files.grantHidden", { name: parse(real).base }));
    this.granted.add(real);
    return real;
  }

  /** True when the path is already inside an allowed folder, no exception thrown. */
  allows(input: string): boolean {
    try {
      this.resolve(input);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The real path, following symlinks — including for a file that doesn't exist
 * yet, where the nearest existing parent is what has to be checked. Writing
 * to a new name inside a symlinked folder is still writing wherever that
 * folder really points.
 */
function realOrPlanned(path: string): string {
  let at = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...tail);
    } catch {
      const { dir, base } = parse(at);
      if (!base || dir === at) return path; // nothing of it exists; take it as written
      tail.unshift(base);
      at = dir;
    }
  }
}

/**
 * Rewrites a Turkish folder name to the one on disk. Only whole segments,
 * and only names that are folders in the home directory anyway.
 */
function withAliases(path: string): string {
  const segments = path.split(sep);
  const mapped = segments.map((segment, i) => {
    const english = ALIASES[plain(segment)];
    if (!english) return segment;
    // "Belgeler/rapor.txt" or "/Users/x/Belgeler/rapor.txt", not a file
    // called Belgeler halfway down some other tree.
    const inHome = i === 0 || segments.slice(0, i).join(sep) === homedir();
    return inHome ? english : segment;
  });
  return mapped.join(sep);
}

function hidden(relativePath: string): boolean {
  return relativePath.split(sep).some((segment) => segment.startsWith("."));
}

/**
 * Why a folder can't be a project, in the user's language, or null if it can.
 * A project opens its whole folder to the agent, so the folder has to be a
 * piece of the user's own work: not the home folder itself (that would open
 * everything), not Library (every app's data and tokens), not a hidden
 * folder, and not Vunemi's own data.
 */
export function projectFolderProblem(folder: string, home = homedir(), own: readonly string[] = []): string | null {
  let real: string;
  try {
    real = realpathSync(resolve(folder));
    if (!statSync(real).isDirectory()) return t("files.project.notFolder");
  } catch {
    return t("files.project.notFolder");
  }
  const realHome = realOrPlanned(home);
  if (real !== realHome && !real.startsWith(realHome + sep)) return t("files.project.outsideHome");
  if (real === realHome) return t("files.project.home");
  const inside = relative(realHome, real);
  if (inside === "Library" || inside.startsWith(`Library${sep}`)) return t("files.project.library");
  if (hidden(inside)) return t("files.project.hidden");
  for (const path of own) {
    const mine = realOrPlanned(resolve(path));
    if (real === mine || real.startsWith(mine + sep) || mine.startsWith(real + sep)) return t("files.project.own");
  }
  return null;
}
