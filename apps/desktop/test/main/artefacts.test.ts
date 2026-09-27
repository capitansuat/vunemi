/**
 * The Artefacts store: what Vunemi made, kept long after the activity log has
 * scrolled past it. The cases that matter are the ones where the list could
 * lie — showing a thing that was undone, the same file twice, or offering to
 * open something that would run a program.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Produced } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtefactStore, openable } from "../../src/main/artefacts.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-artefacts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const started = (runId: string, goal: string): AgentEvent => ({ type: "run.started", runId, goal, model: "m", at: 0 }) as AgentEvent;
const finished = (runId: string, callId: string, produced?: Produced[], ok = true): AgentEvent =>
  ({ type: "tool.finished", runId, callId, ok, output: "", durationMs: 1, ...(produced && { produced }) }) as AgentEvent;

describe("what goes in", () => {
  it("keeps what a call made, with the task it was for, across a restart", async () => {
    const store = new ArtefactStore(dir);
    store.record(started("r1", "fiyatları karşılaştır"));
    store.record(finished("r1", "c1", [{ kind: "file", path: "/Users/u/Desktop/fiyat.md" }]));
    await store.flushed();

    const again = await new ArtefactStore(dir).list();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ callId: "c1", goal: "fiyatları karşılaştır", item: { kind: "file", path: "/Users/u/Desktop/fiyat.md" } });
  });

  it("ignores calls that made nothing", async () => {
    const store = new ArtefactStore(dir);
    store.record(finished("r1", "c1"));
    expect(await store.list()).toEqual([]);
  });

  it("puts the newest first", async () => {
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/a.md" }]);
    store.add("c2", "mail_draft", [{ kind: "draft", account: "x", subject: "S", to: ["y@example.com"] }]);
    expect((await store.list()).map((a) => a.callId)).toEqual(["c2", "c1"]);
  });
});

describe("what the list must not claim", () => {
  it("drops a thing once it was undone, and remembers that after a restart", async () => {
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/a.md" }]);
    store.add("c2", "calendar_create", [{ kind: "event", title: "Diş", start: "2026-09-25T14:00:00+03:00" }]);
    store.markUndone("c1");
    await store.flushed();

    expect((await store.list()).map((a) => a.callId)).toEqual(["c2"]);
    expect((await new ArtefactStore(dir).list()).map((a) => a.callId)).toEqual(["c2"]);
  });

  it("shows a file written twice once, as its latest version", async () => {
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/rapor.md" }]);
    store.add("c2", "files_write", [{ kind: "file", path: "/rapor.md" }]);
    const list = await store.list();
    expect(list.map((a) => a.callId)).toEqual(["c2"]);
  });

  it("shows the earlier version again when a rewrite is undone", async () => {
    // Undoing an overwrite restores the old file: it still exists, and the
    // call that made that version is what the user is looking at again.
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/rapor.md" }]);
    store.add("c2", "files_write", [{ kind: "file", path: "/rapor.md" }]);
    store.markUndone("c2");
    expect((await store.list()).map((a) => a.callId)).toEqual(["c1"]);
  });

  it("survives a half-written last line after a crash", async () => {
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/a.md" }]);
    await store.flushed();
    appendFileSync(join(dir, "artefacts.jsonl"), '{"id":"c2:0","callId":"c2","item":{"ki');
    expect((await new ArtefactStore(dir).list()).map((a) => a.callId)).toEqual(["c1"]);
  });

  it("forgets everything when asked", async () => {
    const store = new ArtefactStore(dir);
    store.add("c1", "files_write", [{ kind: "file", path: "/a.md" }]);
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(readFileSync(join(dir, "artefacts.jsonl"), "utf8")).toBe("");
  });
});

describe("what may be opened with a click", () => {
  it("opens documents, pictures and media", () => {
    for (const name of ["rapor.md", "fatura.PDF", "not.rtf", "tablo.xlsx", "foto.heic", "ses.m4a", "video.mov"]) {
      expect(openable(`/Users/u/Downloads/${name}`), name).toBe(true);
    }
  });

  it("never opens anything that would run", () => {
    // A page the agent read can make it write or download any of these; a
    // click in the list must not be the thing that executes it.
    for (const name of ["kur.command", "x.sh", "Uygulama.app", "paket.pkg", "disk.dmg", "b.scpt", "s.html", "r.svg", "w.workflow", "t.terminal", "adsız"]) {
      expect(openable(`/Users/u/Downloads/${name}`), name).toBe(false);
    }
  });
});
