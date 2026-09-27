import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectInstructions, ProjectStore } from "../../src/main/projects.js";
import { SessionStore } from "../../src/main/sessions.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-projects-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("projects", () => {
  it("are kept, and the same folder twice is one project", () => {
    const folder = join(dir, "Site");
    mkdirSync(folder);
    const store = new ProjectStore(join(dir, "projects.json"));
    const a = store.add(folder);
    expect(store.add(folder).id).toBe(a.id);
    expect(a.name).toBe("Site");
    const again = new ProjectStore(join(dir, "projects.json"));
    expect(again.list()).toEqual([a]);
    // Only the owner reads it: it lists the user's folders.
    expect(statSync(join(dir, "projects.json")).mode & 0o777).toBe(0o600);
  });

  it("are forgotten without touching the folder", () => {
    const folder = join(dir, "Site");
    mkdirSync(folder);
    const store = new ProjectStore(join(dir, "projects.json"));
    const a = store.add(folder);
    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(statSync(folder).isDirectory()).toBe(true);
  });

  it("say when their folder has gone", () => {
    const folder = join(dir, "Site");
    mkdirSync(folder);
    const store = new ProjectStore(join(dir, "projects.json"));
    store.add(folder);
    rmSync(folder, { recursive: true });
    expect(store.views()[0]!.missing).toBe(true);
  });

  it("ignore a damaged file rather than trusting it", () => {
    const file = join(dir, "projects.json");
    const store = new ProjectStore(file);
    store.add(join(dir, "A"));
    const text = readFileSync(file, "utf8").replace(/"id":"p_[a-z0-9]+"/, '"id":"../../x"');
    writeFileSync(file, text);
    expect(new ProjectStore(file).list()).toEqual([]);
  });

  it("tell the model where the work goes, and when the files are out of reach", () => {
    const project = { id: "p_abcdef12", name: "Café", folder: "/Users/x/Café", createdAt: 1 };
    expect(projectInstructions(null, true)).toBe("");
    const on = projectInstructions(project, true);
    expect(on).toContain("/Users/x/Café");
    expect(on).toContain("files_edit");
    expect(projectInstructions(project, false)).toMatch(/Files connection is off/);
  });
});

describe("a conversation in a project", () => {
  it("keeps its project, in the list and after reopening", () => {
    const store = new SessionStore(join(dir, "sessions"));
    store.create(undefined, "p_abcdef12");
    expect(store.currentProject).toBe("p_abcdef12");
    store.record({ type: "run.started", runId: "r1", goal: "Make a site", at: 1 } as never);
    store.record({ type: "run.finished", runId: "r1", status: "done", at: 2 } as never);
    const id = store.currentId;
    expect(store.list()[0]!.projectId).toBe("p_abcdef12");

    store.create();
    expect(store.currentProject).toBeUndefined();
    store.open(id);
    expect(store.currentProject).toBe("p_abcdef12");
  });

  it("a fresh conversation moved to no project loses it", () => {
    const store = new SessionStore(join(dir, "sessions"));
    store.create(undefined, "p_abcdef12");
    store.create();
    expect(store.currentProject).toBeUndefined();
  });

  it("keeps its project when a task cut short is recovered", () => {
    const first = new SessionStore(join(dir, "sessions"));
    first.create(undefined, "p_abcdef12");
    first.record({ type: "run.started", runId: "r1", goal: "Make a site", at: 1 } as never);
    first.checkpoint([{ role: "user", content: "<user_request>Make a site</user_request>" }] as never);
    const id = first.currentId;
    // Vunemi closed mid-task; the next start folds the checkpoint in.
    const next = new SessionStore(join(dir, "sessions"));
    expect(next.list().find((s) => s.id === id)?.projectId).toBe("p_abcdef12");
  });
});
