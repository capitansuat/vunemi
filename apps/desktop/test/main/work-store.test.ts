import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationScope, NOTE_LIMITS, projectScope, WorkStore } from "../../src/main/work/store.js";

let dir = "";
let clock = 1_000;
let store: WorkStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-work-"));
  clock = 1_000;
  store = new WorkStore(dir, () => clock);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const note = (over: Partial<{ scope: string; conversationId: string; title: string; text: string; sources: string[] }> = {}) =>
  store.writeNote({ scope: projectScope("p1"), conversationId: "c1", title: "Logo decision", text: "The logo stays orange.", sources: [], ...over });

describe("outputs", () => {
  it("numbers outputs per conversation and keeps them across a reopen, owner-only", () => {
    expect(store.addOutput("c1", "page_read", "long page", 4)).toBe("o1");
    expect(store.addOutput("c1", "page_read", "second", 4)).toBe("o2");
    expect(store.addOutput("c2", "files_read", "other", 4)).toBe("o1");
    expect(statSync(join(dir, "work.db")).mode & 0o777).toBe(0o600);
    store.close();
    store = new WorkStore(dir, () => clock);
    expect(store.output("c1", "o2")).toEqual({ tool: "page_read", text: "second", part: 4 });
    expect(store.output("c2", "o2")).toBeNull();
  });

  it("never reuses an id, and keeps at most 30 per conversation", () => {
    for (let i = 0; i < 31; i++) store.addOutput("c1", "t", `x${i}`, 1);
    expect(store.output("c1", "o1")).toBeNull();
    expect(store.output("c1", "o31")).toMatchObject({ text: "x30" });
    expect(store.addOutput("c1", "t", "y", 1)).toBe("o32");
  });

  it("drops outputs unused for 30 days, and keeps those read since", () => {
    store.addOutput("c1", "t", "old", 1);
    store.addOutput("c1", "t", "read", 1);
    clock += 20 * 86_400_000;
    store.output("c1", "o2");
    clock += 11 * 86_400_000;
    store.prune();
    expect(store.output("c1", "o1")).toBeNull();
    expect(store.output("c1", "o2")).not.toBeNull();
  });

  it("keeps at most 20 MB in all, oldest first", () => {
    const big = "x".repeat(6 * 1024 * 1024);
    for (const c of ["c1", "c2", "c3", "c4"]) store.addOutput(c, "t", big, 1000);
    expect(store.output("c1", "o1")).toBeNull();
    expect(store.output("c4", "o1")).not.toBeNull();
  });
});

describe("notes", () => {
  it("replaces a note with the same title in the same scope, whatever its case", () => {
    const first = note();
    clock = 2_000;
    const second = note({ title: "logo DECISION", text: "Orange, with a white outline." });
    expect(second.replaced).toBe(true);
    expect(second.note.id).toBe(first.note.id);
    expect(store.listNotes(projectScope("p1"))).toEqual([expect.objectContaining({ title: "logo DECISION", text: "Orange, with a white outline.", createdAt: 1_000, updatedAt: 2_000 })]);
    expect(note({ scope: conversationScope("c9") }).replaced).toBe(false);
  });

  it("refuses notes past the limits", () => {
    expect(() => note({ title: "" })).toThrow(/title/);
    expect(() => note({ title: "t".repeat(NOTE_LIMITS.title + 1) })).toThrow(/title/);
    expect(() => note({ text: "x".repeat(NOTE_LIMITS.text + 1) })).toThrow(/4,000/);
    for (let i = 0; i < NOTE_LIMITS.perScope; i++) note({ title: `n${i}` });
    expect(() => note({ title: "one more" })).toThrow(/200/);
    expect(note({ title: "n5", text: "replacing still works" }).replaced).toBe(true);
  });

  it("reads by title, searches by words, and lists newest first, within a scope", () => {
    note();
    clock = 2_000;
    note({ title: "Hotel options, Rome", text: "Hotel Artemide, 3 nights, 180 EUR a night." });
    note({ scope: projectScope("p2"), title: "Other project", text: "logo is blue" });
    expect(store.readNote(projectScope("p1"), "hotel options, rome")?.text).toContain("Artemide");
    expect(store.searchNotes(projectScope("p1"), "logo orange").map((n) => n.title)).toEqual(["Logo decision"]);
    expect(store.searchNotes(projectScope("p1"), "blue")).toEqual([]);
    expect(store.listNotes(projectScope("p1")).map((n) => n.title)).toEqual(["Hotel options, Rome", "Logo decision"]);
  });

  it("forgets a conversation's outputs and own notes, but not what it wrote into its project", () => {
    store.addOutput("c1", "t", "x", 1);
    note({ scope: conversationScope("c1"), title: "Mine" });
    note({ title: "Project's" });
    store.forgetConversation("c1");
    expect(store.output("c1", "o1")).toBeNull();
    expect(store.listNotes(conversationScope("c1"))).toEqual([]);
    expect(store.listNotes(projectScope("p1")).map((n) => n.title)).toEqual(["Project's"]);
    expect(store.addOutput("c1", "t", "again", 1)).toBe("o1");
  });

  it("forgets a project's notes, and deletes one note by id", () => {
    const kept = note({ scope: projectScope("p2"), title: "Stays" });
    note();
    store.forgetProject("p1");
    expect(store.listNotes(projectScope("p1"))).toEqual([]);
    store.deleteNote(kept.note.id);
    expect(store.listNotes(projectScope("p2"))).toEqual([]);
    expect(store.searchNotes(projectScope("p2"), "stays")).toEqual([]);
  });

  it("keeps the sources of a note written after outside content", () => {
    note({ sources: ["booking.com", "Mail"] });
    expect(store.readNote(projectScope("p1"), "Logo decision")?.sources).toEqual(["booking.com", "Mail"]);
  });
});
