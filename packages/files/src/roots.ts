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

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { t } from "@vunemi/i18n";
import { sameFolder, windowsPathProblem, within } from "./windows-paths.js";

/**
 * Finder shows these folders with Turkish names while the disk keeps the
 * English ones. Someone who says "Belgeler" — and a model that repeats them
 * — means ~/Documents, and refusing that is pedantry, not safety: the alias
 * only ever resolves to a folder that is already open.
 */
const ALIASES: Record<string, string> = {
  // The English names too: "Documents/rapor.txt" means the home folder's
  // Documents, not a new Documents inside whichever folder is open first.
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
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

/**
 * Where the system keeps the three standard folders, when it isn't the home
 * folder's own Desktop, Documents and Downloads: on Windows OneDrive often
 * moves Desktop and Documents into OneDrive (sometimes under a local name).
 */
export type KnownFolders = { Desktop: string; Documents: string; Downloads: string };

/** The folders a fresh install opens up. Everything else is closed. */
export function defaultRoots(home = homedir(), known: Partial<KnownFolders> = {}): string[] {
  return [known.Desktop ?? join(home, "Desktop"), known.Documents ?? join(home, "Documents"), known.Downloads ?? join(home, "Downloads")];
}

/** What a Roots holds, sent to the session process so it can name files the way the tools do. */
export interface RootsSnapshot {
  roots: string[];
  projects: string[];
  active: string | null;
  granted: string[];
  /** Only when the system keeps a standard folder elsewhere (see KnownFolders). */
  known?: Partial<KnownFolders>;
}

export class Roots {
  private readonly base: string[];
  /** Project folders the user chose, and the one the current conversation works in. */
  private projects: string[] = [];
  private active: string | null = null;
  /** Single files the user handed over by attaching them. Read-only, and only themselves. */
  private readonly granted = new Set<string>();
  private readonly known: Partial<KnownFolders>;

  constructor(roots: readonly string[] = defaultRoots(), opts: { known?: Partial<KnownFolders> } = {}) {
    this.known = { ...opts.known };
    // Resolve the roots themselves too: on macOS /tmp and even the home
    // directory can be symlinks, and a root that isn't real can't be matched.
    this.base = roots.map((r) => realOrPlanned(resolve(r)));
  }

  snapshot(): RootsSnapshot {
    return {
      roots: [...this.base], projects: [...this.projects], active: this.active, granted: [...this.granted],
      ...(Object.keys(this.known).length > 0 && { known: { ...this.known } }),
    };
  }

  static from(snapshot: RootsSnapshot): Roots {
    const roots = new Roots(snapshot.roots, { ...(snapshot.known && { known: snapshot.known }) });
    roots.setProjects(snapshot.projects, snapshot.active);
    for (const file of snapshot.granted) roots.granted.add(file);
    return roots;
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

    // Windows takes / as well as \; models write both, and ~/ most of all.
    const written = process.platform === "win32" ? raw.replace(/\//g, "\\") : raw;
    const expanded = written === "~" || written.startsWith(`~${sep}`) ? join(homedir(), written.slice(1)) : written;
    if (process.platform === "win32" && windowsPathProblem(expanded)) {
      throw new PathRefused(t("files.pathUnsupported", { path: raw }));
    }
    const { path: named, inHome } = withAliases(expanded, this.known);
    // "\Users\x\..." or "/Users/x/..." without a drive means "on the current
    // drive", which nobody chose: never taken as written. When it reads like a
    // home folder and the rest is open, the path it meant is said instead.
    if (process.platform === "win32" && named.startsWith("\\")) {
      const rest = /^\\(?:Users|home)\\[^\\]+\\(.+)$/i.exec(named)?.[1];
      if (rest && this.list().some((r) => within(join(realOrPlanned(homedir()), rest), r))) {
        throw new PathRefused(t("files.wrongHome", { path: raw, fixed: `~\\${rest}` }));
      }
      throw new PathRefused(t("files.pathUnsupported", { path: raw }));
    }
    // A bare name belongs to the first open folder; a Finder name like
    // "Belgeler/rapor.txt" names a folder in the home directory.
    const roots = this.list();
    const base = inHome ? homedir() : (roots[0] ?? homedir());
    const absolute = isAbsolute(named) ? normalize(named) : join(base, named);
    const real = realOrPlanned(absolute);

    // The deepest match: a project inside Documents is judged as the project.
    const root = roots.filter((r) => within(real, r)).sort((a, b) => b.length - a.length)[0];
    if (!root && access === "read" && this.granted.has(real)) return real;
    if (!root) {
      // "/Users/vunemi/Downloads/x", "/home/user/Downloads/x": a home folder
      // the model made up. Said as what it is, with the path it meant: told
      // only "outside the open folders", Qwen3.8 35B decided the folder was
      // missing and wrote elsewhere. Read from the path as given: macOS keeps
      // /home somewhere else, and nothing here exists to be a link.
      // On Windows the same shape with a drive: C:\Users\someone-else\...
      const guessed = process.platform === "win32"
        ? /^([A-Za-z]:\\Users)\\([^\\]+)\\(.+)$/i.exec(absolute)
        : /^\/(Users|home)\/([^/]+)\/(.+)$/.exec(absolute);
      if (guessed && !existsSync(process.platform === "win32" ? join(guessed[1]!, guessed[2]!) : join(sep, guessed[1]!, guessed[2]!))) {
        const meant = join(realOrPlanned(homedir()), guessed[3]!);
        if (roots.some((r) => within(meant, r))) {
          throw new PathRefused(t("files.wrongHome", { path: raw, fixed: `~${sep}${guessed[3]}` }));
        }
      }
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
    if (process.platform === "win32" && windowsPathProblem(String(input ?? "").replace(/\//g, "\\"))) {
      throw new PathRefused(t("files.pathUnsupported", { path: input }));
    }
    const real = realOrPlanned(resolve(String(input ?? "")));
    let file: boolean;
    try {
      file = statSync(real).isFile();
    } catch {
      throw new PathRefused(t("files.notFound", { path: input }));
    }
    if (!file) throw new PathRefused(t("files.grantNotFile", { name: parse(real).base }));
    // Compared as the real path: a home folder written another way (a link,
    // a Windows 8.3 short name) would otherwise let its hidden files through.
    const home = realOrPlanned(homedir());
    const inside = !sameFolder(real, home) && within(real, home) ? relative(home, real) : parse(real).base;
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
      return join(realPath(at), ...tail);
    } catch {
      const { dir, base } = parse(at);
      if (!base || dir === at) return path; // nothing of it exists; take it as written
      tail.unshift(base);
      at = dir;
    }
  }
}

/**
 * The real path of something that exists. On Windows the system's own answer:
 * it also expands 8.3 short names (a dot folder's short name has no dot) and
 * gives the names in the disk's letter case.
 */
function realPath(path: string): string {
  return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
}

/**
 * Rewrites a Turkish (or English) standard folder name to the folder it means:
 * where the system keeps it, else the home folder's own. Only whole segments,
 * only at the start or right after the home folder; `inHome` says the path now
 * starts from the home folder rather than from the first open folder.
 */
function withAliases(path: string, known: Partial<KnownFolders> = {}): { path: string; inHome: boolean } {
  const segments = path.split(sep);
  const mapped: string[] = [];
  let found = false;
  for (const [i, segment] of segments.entries()) {
    const english = ALIASES[plain(segment)] as keyof KnownFolders | undefined;
    // "Belgeler/rapor.txt" or "/Users/x/Belgeler/rapor.txt", not a file
    // called Belgeler halfway down some other tree.
    const inHome = english && (i === 0 || sameFolder(segments.slice(0, i).join(sep), homedir()));
    if (!inHome) {
      mapped.push(segment);
      continue;
    }
    // Where the system keeps that folder, when it isn't in the home folder.
    const moved = known[english];
    if (moved) return { path: join(moved, ...segments.slice(i + 1)), inHome: true };
    mapped.push(english);
    found = true;
  }
  return { path: mapped.join(sep), inHome: found };
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
    real = realPath(resolve(folder));
    if (!statSync(real).isDirectory()) return t("files.project.notFolder");
  } catch {
    return t("files.project.notFolder");
  }
  const realHome = realOrPlanned(home);
  if (!within(real, realHome)) return t("files.project.outsideHome");
  if (sameFolder(real, realHome)) return t("files.project.home");
  const inside = relative(realHome, real);
  if (inside === "Library" || inside.startsWith(`Library${sep}`)) return t("files.project.library");
  // Windows' Library: every app's settings, caches and tokens.
  if (process.platform === "win32" && within(join(realHome, inside), join(realHome, "AppData"))) return t("files.project.appData");
  if (hidden(inside)) return t("files.project.hidden");
  for (const path of own) {
    const mine = realOrPlanned(resolve(path));
    if (within(real, mine) || within(mine, real)) return t("files.project.own");
  }
  return null;
}
