/**
 * The user's projects: a folder they picked, a name, and the conversations
 * that belong to it. Picking the folder is what opens it to the agent;
 * forgetting a project closes it again and leaves the folder as it is.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProjectView } from "../shared/ipc.js";

export interface Project {
  id: string;
  name: string;
  folder: string;
  createdAt: number;
}

interface Stored {
  version: 1;
  projects: Project[];
}

const ID = /^p_[a-z0-9]{6,40}$/;
const NAME_CHARS = 60;

export class ProjectStore {
  private projects: Project[];

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.projects = this.read();
  }

  list(): Project[] {
    return [...this.projects];
  }

  get(id: string | undefined): Project | null {
    return (id && this.projects.find((p) => p.id === id)) || null;
  }

  /** The same folder twice is one project: the existing one comes back. */
  add(folder: string, name = basename(folder)): Project {
    const existing = this.projects.find((p) => p.folder === folder);
    if (existing) return existing;
    const at = this.now();
    const project: Project = {
      id: `p_${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: cleanName(name) || basename(folder),
      folder,
      createdAt: at,
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  /** Forgets it. The folder and what is in it stay where they are. */
  remove(id: string): void {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length !== before) this.save();
  }

  views(): ProjectView[] {
    return this.projects.map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.folder.startsWith(homedir()) ? `~${p.folder.slice(homedir().length)}` : p.folder,
      missing: !isFolder(p.folder),
    }));
  }

  private read(): Project[] {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Stored;
      if (value?.version !== 1 || !Array.isArray(value.projects)) return [];
      return value.projects.filter(
        (p) => ID.test(String(p?.id)) && typeof p.folder === "string" && p.folder.startsWith("/") && typeof p.name === "string",
      );
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, projects: this.projects } satisfies Stored), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, NAME_CHARS);
}

function isFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the model is told about the project the conversation belongs to.
 * `filesOn`: whether the file tools exist right now; `writeOn`: whether the
 * ones that change files do.
 */
export function projectInstructions(project: Project | null, filesOn: boolean, writeOn = filesOn): string {
  if (!project) return "";
  const lines = [
    `Project: this conversation belongs to the user's project "${project.name}". Its folder is ${project.folder}.`,
  ];
  if (!filesOn) {
    lines.push("- The Files connection is off, so you can't see the folder. If the task needs its files, tell the user to switch Files on under Connections.");
    return lines.join("\n");
  }
  if (!writeOn) {
    lines.push("- You can read the folder but not change it: writing files is switched off under Connections › Files. If the task needs files made or changed, tell the user.");
  }
  lines.push(
    "- Keep the files for this work in the project folder. A file name without a folder means a file there.",
    "- Look at what is already in it with files_list before making new files, and build on what is there.",
    "- Change part of an existing file with files_edit; write new files with files_write, which also makes any folders they need.",
    "- A website here is plain HTML, CSS and JavaScript files that open by double-clicking index.html: no build tools, no packages to install, no downloads.",
    "- When you have made or changed files, say which ones, in a short list.",
  );
  return lines.join("\n");
}
