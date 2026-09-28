/**
 * Meetings on disk: owner-only, found again, searched, and sent to a stand-in
 * Trash rather than deleted.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeetingStore } from "../../src/main/meetings/store.js";

let root: string;
let trashed: string[];
let store: MeetingStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vunemi-meetings-"));
  trashed = [];
  store = new MeetingStore(join(root, "meetings"), async (path) => {
    trashed.push(path);
    rmSync(path, { recursive: true });
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("MeetingStore", () => {
  it("creates owner-only meetings and reads them back", () => {
    const m = store.create();
    expect(m.state).toBe("recording");
    expect(statSync(join(root, "meetings")).mode & 0o777).toBe(0o700);
    expect(statSync(store.folder(m.id)).mode & 0o777).toBe(0o700);
    m.lines.push({ source: "me", start: 1, end: 2, text: "Merhaba" });
    m.title = "Bütçe";
    store.save(m);
    expect(statSync(join(store.folder(m.id), "meeting.json")).mode & 0o777).toBe(0o600);
    expect(store.get(m.id)).toEqual(m);
  });

  it("lists newest first without the transcript", () => {
    const a = store.create();
    const b = store.create();
    b.startedAt = a.startedAt + 1000;
    store.save(b);
    const list = store.list();
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]);
    expect(list[0]).not.toHaveProperty("lines");
  });

  it("searches titles, summaries and words, ignoring case", () => {
    const a = store.create();
    a.title = "Haftalık Plan";
    a.lines.push({ source: "others", start: 0, end: 1, text: "Bütçe cuma günü bitiyor" });
    store.save(a);
    const b = store.create();
    b.summary = "## Summary\nThe BUDGET is fine";
    store.save(b);
    expect(store.search("bütçe CUMA")).toEqual([a.id]);
    expect(store.search("budget")).toEqual([b.id]);
    expect(store.search("haftalık")).toEqual([a.id]);
    expect(store.search("nothing here")).toEqual([]);
  });

  it("finds the meetings left unfinished", () => {
    const a = store.create();
    const b = store.create();
    b.state = "done";
    store.save(b);
    const c = store.create();
    c.state = "summarising";
    store.save(c);
    expect(store.unfinished().map((m) => m.id).sort()).toEqual([a.id, c.id].sort());
  });

  it("refuses ids that are paths", () => {
    expect(() => store.folder("../x")).toThrow();
    expect(store.get("../../etc")).toBeNull();
  });

  it("sends audio, then the whole meeting, to the Trash", async () => {
    const m = store.create();
    writeFileSync(join(store.folder(m.id), "mic.pcm"), "x");
    await store.dropAudio(m.id);
    expect(trashed).toEqual([join(store.folder(m.id), "mic.pcm")]);
    expect(store.get(m.id)).not.toBeNull();
    await store.remove(m.id);
    expect(existsSync(store.folder(m.id))).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
