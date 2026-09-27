import { describe, expect, it } from "vitest";
import { createNotesTools, createRunner, RECENTLY_DELETED } from "../src/index.js";

const live = process.env.TENAMI_LIVE_APPS === "1";

// Leaves notes titled "Vunemi test …" behind.
describe.skipIf(!live)("Notes, for real", () => {
  it("creates, finds, reads and appends to a note", async () => {
    const tools = createNotesTools(createRunner());
    const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(args, {} as never);
    const title = `Vunemi test ${Date.now()}`;
    const made = await call("notes_create", { title, body: "first line" });
    const id = /id=(\S+)\)/.exec(made)![1]!;
    expect(await call("notes_search", { query: title })).toContain(id);
    await call("notes_append", { id, text: "second line" });
    const text = await call("notes_read", { id });
    expect(text).toContain("first line");
    expect(text).toContain("second line");
  }, 60_000);

  // Leaves the test note in Recently Deleted, where Notes empties it in 30 days.
  it("changes a passage and deletes a note, and undoes both", async () => {
    const tools = createNotesTools(createRunner());
    const undos: (() => Promise<void>)[] = [];
    const ctx = { offerUndo: (_label: string, run: () => Promise<void>) => undos.push(run) } as never;
    const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(args, ctx);
    const title = `Vunemi test ${Date.now()}`;
    const id = /id=(\S+)\)/.exec(await call("notes_create", { title, body: "milk and bread" }))![1]!;
    await call("notes_edit", { id, find: "milk", replace: "cheese" });
    expect(await call("notes_read", { id })).toContain("cheese and bread");
    await undos.pop()!();
    expect(await call("notes_read", { id })).toContain("milk and bread");
    expect(await call("notes_delete", { id })).toMatch(/Moved the note/);
    await undos.pop()!();
    expect(await call("notes_search", { query: title })).toContain(id);
    const where = /to (.+)\. The user/.exec(await call("notes_delete", { id }))![1]!;
    // Only asked again when the folder is one Vunemi knows by name: otherwise
    // this would test a permanent delete on the test note.
    expect(RECENTLY_DELETED).toContain(where);
    await expect(call("notes_delete", { id })).rejects.toThrow(/for good/);
  }, 90_000);
});
