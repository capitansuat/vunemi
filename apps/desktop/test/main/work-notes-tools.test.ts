// apps/desktop/test/main/work-notes-tools.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "@vunemi/agent-core";
import { createNoteTools } from "../../src/main/work/notes-tools.js";
import { WorkStore, projectScope } from "../../src/main/work/store.js";

let dir = "";
let store: WorkStore;
let where: { conversationId: string; projectId?: string };
let sources: string[];
let saved: { runId?: string; title: string; scope: string }[];
let tools: Map<string, ToolDef>;

const ctx = { signal: new AbortController().signal, runId: "r1" } as unknown as ToolContext;
const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, ctx);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-notes-"));
  store = new WorkStore(dir);
  where = { conversationId: "c1", projectId: "p1" };
  sources = [];
  saved = [];
  tools = new Map(
    createNoteTools({
      store,
      where: () => where,
      sources: () => sources,
      redact: (text) => text.replace("hunter2", "[hidden secret]"),
      onSaved: ({ runId, note, scope }) => saved.push({ ...(runId && { runId }), title: note.title, scope }),
    }).map((t) => [t.name, t]),
  );
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("worknote tools", () => {
  it("writes into the project, says so, and another conversation of it reads the note", async () => {
    expect(await run("worknote_write", { title: "Logo decision", text: "Orange stays." })).toMatch(/Saved "Logo decision" for this project/);
    expect(saved).toEqual([{ runId: "r1", title: "Logo decision", scope: "project" }]);
    where = { conversationId: "c2", projectId: "p1" };
    expect(await run("worknote_read", { title: "logo decision" })).toContain("Orange stays.");
  });

  it("keeps a conversation without a project to itself", async () => {
    where = { conversationId: "c1" };
    expect(await run("worknote_write", { title: "Mine", text: "x" })).toMatch(/for this conversation/);
    where = { conversationId: "c2" };
    await expect(run("worknote_read", { title: "Mine" })).rejects.toThrow(/No note titled "Mine"/);
  });

  it("masks secrets, and records outside content the conversation read", async () => {
    sources = ["booking.com"];
    await run("worknote_write", { title: "Login", text: "password hunter2" });
    const note = store.readNote(projectScope("p1"), "Login")!;
    expect(note.text).toBe("password [hidden secret]");
    expect(note.sources).toEqual(["booking.com"]);
    expect(await run("worknote_read", { title: "Login" })).toContain("Written after reading outside content from: booking.com.");
  });

  it("finds notes by words, and says when none match", async () => {
    await run("worknote_write", { title: "Hotel options, Rome", text: "Artemide, 180 EUR." });
    expect(await run("worknote_search", { query: "rome hotel" })).toContain("Hotel options, Rome");
    expect(await run("worknote_search", { query: "tokyo" })).toBe('No note matches "tokyo".');
  });

  it("has its reads fenced as untrusted, and asks no approval to write", () => {
    expect(tools.get("worknote_read")!.untrustedOutput).toBe(true);
    expect(tools.get("worknote_search")!.untrustedOutput).toBe(true);
    expect(tools.get("worknote_write")!.actionClass).toBe("read");
  });
});
