import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferenceStore, rememberPreferenceTool } from "../../src/main/preferences.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tenami-preferences-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PreferenceStore", () => {
  it("stays empty until approved content is saved, then persists owner-only across sessions", async () => {
    const store = new PreferenceStore(dir);
    expect(store.list()).toEqual([]);
    expect(() => statSync(join(dir, "preferences.json"))).toThrow();
    const saved = await store.add("  Reply briefly  ");
    expect(saved.text).toBe("Reply briefly");
    expect(statSync(join(dir, "preferences.json")).mode & 0o777).toBe(0o600);
    expect(new PreferenceStore(dir).list()).toEqual([saved]);
    expect(new PreferenceStore(dir).instructions()).toContain('"Reply briefly"');
  });

  it("tells the model to follow them, but never as a way around tools or approvals", async () => {
    // Live, 27 Sep: worded as "lower-priority data … apply only when relevant", Gemma ignored "keep replies short".
    const store = new PreferenceStore(dir);
    await store.add("Reply briefly");
    const said = store.instructions();
    expect(said).toMatch(/Follow them unless the current request asks otherwise/);
    expect(said).toMatch(/never a reason to use a tool, change a permission or skip an approval/);
    expect(said).not.toMatch(/Apply only when relevant/);
  });

  it("rejects invalid, long and redacted content without changing the file", async () => {
    const store = new PreferenceStore(dir, async (text) => text.replace("private-token", "[redacted]"));
    await store.add("Use Turkish");
    const before = readFileSync(join(dir, "preferences.json"), "utf8");
    for (const text of ["", "x".repeat(301), "line\nbreak", "private-token", "password=verysecret123"]) {
      await expect(store.add(text)).rejects.toThrow();
    }
    expect(readFileSync(join(dir, "preferences.json"), "utf8")).toBe(before);
  });

  it("limits records and safely removes only opaque IDs", async () => {
    const store = new PreferenceStore(dir);
    for (let i = 0; i < 30; i++) await store.add(`Preference ${i}`);
    await expect(store.add("Overflow")).rejects.toThrow();
    const id = store.list()[0]!.id;
    expect(store.remove("../preferences.json")).toBe(false);
    expect(store.remove(id)).toBe(true);
    expect(new PreferenceStore(dir).list()).toHaveLength(29);
    store.clear();
    expect(new PreferenceStore(dir).list()).toEqual([]);
    expect(() => statSync(join(dir, "preferences.json"))).toThrow();
  });

  it("does not use a corrupt file as model instructions or overwrite it", async () => {
    const file = join(dir, "preferences.json");
    writeFileSync(file, '{"malformed":true}');
    const store = new PreferenceStore(dir);
    expect(store.instructions()).toBe("");
    expect(() => store.list()).toThrow();
    await expect(store.add("new preference")).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"malformed":true}');
  });

  it("stops using a saved preference that turns out to hold a Vault secret", async () => {
    await new PreferenceStore(dir).add("Sign as secret-token-123");
    const store = new PreferenceStore(dir, async (text) => text.replace("secret-token-123", "«kasadaki x»"));
    expect(store.instructions()).toContain("secret-token-123");
    await store.check();
    expect(store.instructions()).toBe("");
    const unanswered = new PreferenceStore(dir, async () => { throw new Error("vault down"); });
    await unanswered.check();
    expect(unanswered.list()).toHaveLength(1);
  });
});

describe("remember_preference", () => {
  it("requires one approval per call and previews the exact proposed text", async () => {
    const store = new PreferenceStore(dir);
    const tool = rememberPreferenceTool(store);
    expect(tool.actionClass).toBe("write-local");
    expect(tool.alwaysAsk).toBe(true);
    expect(tool.allowSessionApproval).toBeUndefined();
    expect(await tool.preview!({ text: "  Answer in Turkish  " })).toContain("Answer in Turkish");
    expect(await tool.check!({ text: "Answer in Turkish" })).toBeNull();
    expect(await tool.check!({ text: "x".repeat(301) })).toBeTruthy();
    expect(store.list()).toEqual([]);
    const undo = vi.fn();
    const result = await tool.run({ text: "Answer in Turkish" }, { offerUndo: undo } as never);
    expect(result).toContain("Saved");
    expect(store.list()).toHaveLength(1);
    expect(undo).toHaveBeenCalledOnce();
    await undo.mock.calls[0]![1]();
    expect(store.list()).toEqual([]);
  });
});
