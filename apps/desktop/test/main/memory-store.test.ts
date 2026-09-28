import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keywordQuery, MemoryStore } from "../../src/main/memory/store.js";

let dir = "";
let store: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-memory-"));
  store = new MemoryStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const said = (quote: string) => ({ quote, sessionId: "s-1", at: 1 });

describe("MemoryStore", () => {
  it("keeps notes with their evidence, owner-only, across restarts", async () => {
    const note = await store.add({ text: "  I want reports as PDF  ", kind: "general", evidence: said("reports as PDF please") });
    expect(note).toMatchObject({ text: "I want reports as PDF", kind: "general", confirmed: 1, givenAt: null });
    expect(note.evidence).toEqual([said("reports as PDF please")]);
    expect(statSync(join(dir, "memory.db")).mode & 0o777).toBe(0o600);
    store.close();
    store = new MemoryStore(dir);
    expect(store.list()).toEqual([note]);
    expect(store.get(note.id)).toEqual(note);
  });

  it("refuses empty, long, multi-line and secret text", async () => {
    store.close();
    store = new MemoryStore(dir, async (text) => text.replace("private-token", "[redacted]"));
    for (const text of ["", "x".repeat(301), "line\nbreak", "private-token", "password=verysecret123"]) {
      await expect(store.add({ text, kind: "general", evidence: said(text || "x") })).rejects.toThrow();
    }
    expect(store.list()).toEqual([]);
  });

  it("finds notes by keyword across Turkish letters and suffixes", async () => {
    const pdf = await store.add({ text: "Raporları PDF olarak isterim", kind: "general", evidence: said("raporları pdf") });
    const ayse = await store.add({ text: "Müdürüm Ayşe Kaya", kind: "topic", evidence: said("müdürüm ayşe") });
    expect(store.keyword("rapor hazırla", 5).map((hit) => hit.id)).toEqual([pdf.id]);
    expect(store.keyword("raporlarımı gönder", 5).map((hit) => hit.id)).toEqual([pdf.id]);
    expect(store.keyword("ayse ile toplantı", 5).map((hit) => hit.id)).toEqual([ayse.id]);
    expect(store.keyword("hava nasıl", 5)).toEqual([]);
    expect(store.keyword('"); DROP TABLE notes; --', 5)).toEqual([]);
  });

  it("builds a keyword query that can't be used as FTS syntax", () => {
    // First five letters: Turkish suffixes still match (the "F5" stem).
    expect(keywordQuery('a "rapor"* OR NEAR(x) raporlarımı')).toBe('"rapor"* OR "or"* OR "near"*');
    expect(keywordQuery("?!")).toBe("");
  });

  it("confirms a note with new evidence and keeps the last five", async () => {
    const note = await store.add({ text: "Reply briefly", kind: "general", evidence: said("keep it short 0") });
    for (let i = 1; i <= 6; i++) store.confirm(note.id, { quote: `keep it short ${i}`, sessionId: null, at: i + 1 });
    const after = store.get(note.id)!;
    expect(after.confirmed).toBe(7);
    expect(after.evidence.map((e) => e.quote)).toEqual([2, 3, 4, 5, 6].map((i) => `keep it short ${i}`));
  });

  it("re-indexes an updated note and drops its old vector", async () => {
    const note = await store.add({ text: "Manager is Ayşe", kind: "topic", evidence: said("manager is ayşe") });
    store.setVector(note.id, "m", new Float32Array([1, 0]));
    await store.update(note.id, "Manager is Deniz", said("my manager is Deniz now"));
    expect(store.keyword("ayse", 5)).toEqual([]);
    expect(store.keyword("deniz", 5).map((hit) => hit.id)).toEqual([note.id]);
    expect(store.vectors("m")).toEqual([]);
    expect(store.get(note.id)!.evidence).toHaveLength(2);
  });

  it("keeps vectors per model and lists notes without one", async () => {
    const a = await store.add({ text: "Note a", kind: "topic", evidence: said("note a") });
    const b = await store.add({ text: "Note b", kind: "topic", evidence: said("note b") });
    store.setVector(a.id, "m", new Float32Array([0.5, -0.25, 1]));
    expect(store.vectors("m")).toEqual([{ id: a.id, vector: new Float32Array([0.5, -0.25, 1]) }]);
    expect(store.vectors("other")).toEqual([]);
    expect(store.missingVectors("m").map((n) => n.id)).toEqual([b.id]);
  });

  it("orders general notes by confirmations, then by recency", async () => {
    const a = await store.add({ text: "A", kind: "general", evidence: said("a") });
    const b = await store.add({ text: "B", kind: "general", evidence: said("b") });
    await store.add({ text: "C", kind: "topic", evidence: said("c") });
    store.confirm(a.id, said("a again"));
    expect(store.general(5).map((n) => n.id)).toEqual([a.id, b.id]);
    expect(store.general(1).map((n) => n.id)).toEqual([a.id]);
  });

  it("marks notes as given", async () => {
    const a = await store.add({ text: "A", kind: "general", evidence: said("a") });
    store.markGiven([a.id], 42);
    expect(store.get(a.id)!.givenAt).toBe(42);
  });

  it("removes a note with its evidence, and forgets everything", async () => {
    const a = await store.add({ text: "A", kind: "general", evidence: said("a") });
    await store.add({ text: "B", kind: "general", evidence: said("b") });
    expect(store.remove("nope")).toBe(false);
    expect(store.remove(a.id)).toBe(true);
    expect(store.list().map((n) => n.text)).toEqual(["B"]);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.keyword("b", 5)).toEqual([]);
  });

  it("holds at most 500 notes", async () => {
    for (let i = 0; i < 500; i++) await store.add({ text: `Note ${i}`, kind: "topic", evidence: said(`note ${i}`) });
    await expect(store.add({ text: "One more", kind: "topic", evidence: said("one more") })).rejects.toThrow();
  });

  it("withholds a note the Vault now recognises as a secret from searches", async () => {
    const a = await store.add({ text: "Code word bluefin", kind: "topic", evidence: said("code word bluefin") });
    store.close();
    store = new MemoryStore(dir, async (text) => text.replace("bluefin", "[redacted]"));
    await store.check();
    expect(store.keyword("bluefin", 5)).toEqual([]);
    expect(store.list().map((n) => n.id)).toEqual([a.id]);
  });
});

describe("moving Preferences into memory", () => {
  it("turns each preference into a general note and keeps the old file as .bak", () => {
    store.close();
    rmSync(join(dir, "memory.db"));
    const prefs = [{ id: "00000000-0000-4000-8000-000000000001", text: "Reply briefly", createdAt: 5 }];
    writeFileSync(join(dir, "preferences.json"), JSON.stringify(prefs));
    store = new MemoryStore(dir);
    expect(store.list()).toMatchObject([{ text: "Reply briefly", kind: "general", createdAt: 5, evidence: [{ quote: "Reply briefly", sessionId: null }] }]);
    expect(existsSync(join(dir, "preferences.json"))).toBe(false);
    expect(existsSync(join(dir, "preferences.json.bak"))).toBe(true);
  });

  it("leaves a corrupt preferences file where it is", () => {
    store.close();
    rmSync(join(dir, "memory.db"));
    writeFileSync(join(dir, "preferences.json"), '{"malformed":true}');
    store = new MemoryStore(dir);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, "preferences.json"))).toBe(true);
  });
});
