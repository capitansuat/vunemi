import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@ocak/agent-core";
import { createNotesTools, NOTES_APPEND, NOTES_CREATE, NOTES_DELETE, NOTES_EDIT, NOTES_INFO, NOTES_READ, NOTES_RESTORE, NOTES_SEARCH, NOTES_SET_BODY } from "../src/notes.js";

const ctx = {} as ToolContext;
const byName = (tools: ReturnType<typeof createNotesTools>, name: string) => tools.find((t) => t.name === name)!;

describe("Notes tools", () => {
  it("searches with the fixed template and lists what it found", async () => {
    const run = vi.fn(async () => [{ id: "x-coredata://1", name: "Shopping", folder: "Notes", modified: "2026-09-24T10:00:00Z" }]);
    const out = await byName(createNotesTools(run), "notes_search").run({ query: "milk" }, ctx);
    expect(run).toHaveBeenCalledWith(NOTES_SEARCH, { app: "Notes", query: "milk", folder: null, limit: 20 });
    expect(out).toContain("Shopping");
    expect(out).toContain("x-coredata://1");
  });

  it("says so when nothing matches", async () => {
    const out = await byName(createNotesTools(async () => []), "notes_search").run({ query: "zzz" }, ctx);
    expect(out).toMatch(/No notes/);
  });

  it("reads a note's text, and cuts a very long one", async () => {
    const run = vi.fn(async () => ({ name: "Long", text: "a".repeat(30_000), locked: false }));
    const out = await byName(createNotesTools(run), "notes_read").run({ id: "x-coredata://1" }, ctx);
    expect(run).toHaveBeenCalledWith(NOTES_READ, { app: "Notes", id: "x-coredata://1" });
    expect(out.length).toBeLessThan(21_000);
  });

  it("does not open a locked note", async () => {
    const out = await byName(createNotesTools(async () => ({ name: "Secret", text: "", locked: true })), "notes_read").run({ id: "1" }, ctx);
    expect(out).toMatch(/locked/);
  });

  it("creates and appends with the fixed templates", async () => {
    const run = vi.fn(async () => ({ id: "x-coredata://9", name: "Plan" }));
    const tools = createNotesTools(run);
    await byName(tools, "notes_create").run({ title: "Plan", body: "line 1\nline 2" }, ctx);
    expect(run).toHaveBeenCalledWith(NOTES_CREATE, { app: "Notes", title: "Plan", body: "line 1\nline 2", folder: null, again: false });
    await byName(tools, "notes_append").run({ id: "x-coredata://9", text: "more" }, ctx);
    expect(run).toHaveBeenCalledWith(NOTES_APPEND, { app: "Notes", id: "x-coredata://9", text: "more" });
  });

  it("doesn't make a second note with the same title, and names the note on the append card", async () => {
    const run = vi.fn(async (): Promise<unknown> => ({ exists: { id: "x-coredata://7", name: "Alışveriş" } }));
    const tools = createNotesTools(run);
    const out = await byName(tools, "notes_create").run({ title: "Alışveriş", body: "süt" }, ctx);
    expect(out).toMatch(/Nothing was created.*x-coredata:\/\/7/s);
    expect(await byName(tools, "notes_append").preview!({ id: "x-coredata://7", text: "ekmek" })).toContain("Alışveriş");
    run.mockResolvedValueOnce({ noFolder: true, folders: ["Notes", "İş"] });
    await expect(byName(tools, "notes_create").run({ title: "x", body: "y", folder: "Ev" }, ctx)).rejects.toThrow(/İş/);
  });

  it("refuses empty input before running anything", async () => {
    const run = vi.fn();
    const tools = createNotesTools(run);
    await expect(byName(tools, "notes_search").run({ query: " " }, ctx)).rejects.toThrow();
    await expect(byName(tools, "notes_create").run({ title: "", body: "x" }, ctx)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("marks content as untrusted and changes as local writes", () => {
    const tools = createNotesTools(async () => null);
    expect(byName(tools, "notes_read")).toMatchObject({ actionClass: "read", untrustedOutput: true });
    expect(byName(tools, "notes_search")).toMatchObject({ actionClass: "read", untrustedOutput: true });
    expect(byName(tools, "notes_create").actionClass).toBe("write-local");
    expect(byName(tools, "notes_append").actionClass).toBe("write-local");
  });

  it("keeps every template free of interpolation", () => {
    for (const template of [NOTES_SEARCH, NOTES_READ, NOTES_CREATE, NOTES_APPEND]) {
      expect(template).toContain("JSON.parse(argv[0])");
      expect(template).not.toMatch(/\$\{/);
    }
  });
});

describe("changing and deleting notes", () => {
  const undoCtx = () => {
    const undos: { label: string; run: () => Promise<void> }[] = [];
    return { undos, ctx: { offerUndo: (label: string, run: () => Promise<void>) => undos.push({ label, run }) } as unknown as ToolContext };
  };

  it("changes one passage on a card, and puts the old body back only if nothing changed since", async () => {
    const run = vi.fn(async (template: string): Promise<unknown> =>
      template === NOTES_EDIT ? { id: "n1", name: "Plan", before: "<div>süt</div>", after: "<div>ekmek</div>" } : {});
    const tools = createNotesTools(run);
    const edit = byName(tools, "notes_edit");
    expect(edit.alwaysAsk).toBe(true);
    const { undos, ctx } = undoCtx();
    expect(await edit.run({ id: "n1", find: "süt", replace: "ekmek" }, ctx)).toMatch(/Changed the note "Plan"/);
    expect(run).toHaveBeenCalledWith(NOTES_EDIT, { app: "Notes", id: "n1", find: "süt", replace: "ekmek" });
    await undos[0]!.run();
    expect(run).toHaveBeenLastCalledWith(NOTES_SET_BODY, { app: "Notes", id: "n1", expect: "<div>ekmek</div>", body: "<div>süt</div>" });
    run.mockResolvedValueOnce({ changed: true, name: "Plan" });
    await expect(undos[0]!.run()).rejects.toThrow(/Plan/);
  });

  it("says why a passage can't be changed, and changes nothing", async () => {
    const tools = createNotesTools(vi.fn(async (): Promise<unknown> => ({ count: 2, plain: 2, name: "Plan" })));
    const edit = byName(tools, "notes_edit");
    await expect(edit.run({ id: "n1", find: "a", replace: "b" }, ctx)).rejects.toThrow(/2 times/);
    for (const [answer, why] of [[{ count: 0, plain: 1, name: "P" }, /formatting/], [{ count: 0, plain: 0, name: "P" }, /not in the note/], [{ attachments: true, name: "P" }, /attachments/], [{ locked: true, name: "P" }, /locked/]] as const) {
      await expect(byName(createNotesTools(async () => answer), "notes_edit").run({ id: "n1", find: "a", replace: "b" }, ctx)).rejects.toThrow(why);
    }
    await expect(edit.run({ id: "n1", find: " ", replace: "b" }, ctx)).rejects.toThrow(/empty/);
  });

  it("deletes into Recently Deleted and puts it back; never deletes one already there", async () => {
    const run = vi.fn(async (template: string): Promise<unknown> =>
      template === NOTES_DELETE ? { name: "Plan", from: "folder-1", fromName: "Notes", where: "Recently Deleted" } : { name: "Plan" });
    const del = byName(createNotesTools(run), "notes_delete");
    expect(del.alwaysAsk).toBe(true);
    const { undos, ctx } = undoCtx();
    expect(await del.run({ id: "n1" }, ctx)).toMatch(/to Recently Deleted/);
    expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ id: "n1", trash: expect.arrayContaining(["Recently Deleted", "Son Silinenler"]) });
    await undos[0]!.run();
    expect(run).toHaveBeenLastCalledWith(NOTES_RESTORE, { app: "Notes", id: "n1", folder: "folder-1" });

    await expect(byName(createNotesTools(async () => ({ inTrash: true, name: "Eski" })), "notes_delete").run({ id: "n2" }, ctx)).rejects.toThrow(/for good/);
    const lost = undoCtx();
    expect(await byName(createNotesTools(async () => ({ name: "X", from: "f", where: null })), "notes_delete").run({ id: "n3" }, lost.ctx)).toMatch(/can't be put back/);
    expect(lost.undos).toHaveLength(0);
  });
});

describe("naming notes on cards", () => {
  it("says the title once, and names a listed note on its read card", async () => {
    const run = vi.fn(async (template: string): Promise<unknown> =>
      template === NOTES_SEARCH ? [{ id: "n1", name: "Plan", folder: "Notes", modified: "2026-09-24T10:00:00Z" }] : { name: "Plan", text: "Plan\nsüt al", locked: false });
    const tools = createNotesTools(run);
    expect(await byName(tools, "notes_read").preview!({ id: "n1" })).not.toContain("n1");
    await byName(tools, "notes_search").run({ query: "Plan" }, ctx);
    expect(await byName(tools, "notes_read").preview!({ id: "n1" })).toContain("Plan");
    expect(await byName(tools, "notes_read").run({ id: "n1" }, ctx)).toBe("# Plan\nsüt al");
  });

  it("asks Notes for the name on a delete card, and says when it is already in Recently Deleted", async () => {
    const run = vi.fn(async (template: string): Promise<unknown> => (template === NOTES_INFO ? { name: "Eski", folder: "Recently Deleted" } : {}));
    const card = await byName(createNotesTools(run), "notes_delete").preview!({ id: "n9" });
    expect(card).toContain("Eski");
    expect(card).not.toContain("?");
    expect(run).toHaveBeenCalledWith(NOTES_INFO, { app: "Notes", id: "n9" });
  });
});
