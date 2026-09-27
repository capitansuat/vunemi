import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@vunemi/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityLog } from "../../src/main/activity.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-activity-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (callId: string, tool = "page_click", actionClass: AgentEvent extends never ? never : "outbound" = "outbound") =>
  [
    { type: "run.started", runId: "r", goal: "kulaklık ara", model: "m", at: 1 },
    { type: "tool.proposed", runId: "r", stepId: "s", callId, tool, args: {}, actionClass, preview: 'button "Ara"' },
  ] as AgentEvent[];

const finished = (callId: string, ok = true): AgentEvent => ({
  type: "tool.finished",
  runId: "r",
  callId,
  ok,
  output: ok ? "done" : "Error: nope",
  durationMs: 12,
});

describe("ActivityLog", () => {
  it("records a call with its task, preview and outcome", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1")) log.record(e);
    log.record(finished("c1"));
    const [entry] = await log.list();
    expect(entry).toMatchObject({
      id: "c1",
      goal: "kulaklık ara",
      tool: "page_click",
      preview: 'button "Ara"',
      status: "ok",
      durationMs: 12,
    });
  });

  it("marks refusals and failures, and keeps the newest first", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1")) log.record(e);
    log.record({ type: "approval.resolved", runId: "r", callId: "c1", decision: { kind: "reject" } });
    log.record(finished("c1", false));
    for (const e of call("c2").slice(1)) log.record(e);
    log.record(finished("c2", false));
    const entries = await log.list();
    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ["c2", "error"],
      ["c1", "refused"],
    ]);
  });

  it("offers undo, runs it once, then marks the entry", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1", "scratchpad_write")) log.record(e);
    let undone = 0;
    log.offerUndo("c1", "Önceki hâline döndür", async () => {
      undone++;
    });
    log.record(finished("c1"));
    expect((await log.list())[0]!.undo).toBe("Önceki hâline döndür");

    await log.undo("c1");
    expect(undone).toBe(1);
    const [entry] = await log.list();
    expect(entry).toMatchObject({ undone: true });
    expect(entry!.undo).toBeUndefined();
    await expect(log.undo("c1")).rejects.toThrow(/geri alınamıyor/);
  });

  it("keeps a failed remote undo available for retry", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1", "mail_draft")) log.record(e);
    let attempts = 0;
    log.offerUndo("c1", "Taslağı geri al", async () => {
      if (++attempts === 1) throw new Error("mailbox unavailable");
    });
    log.record(finished("c1"));
    await expect(log.undo("c1")).rejects.toThrow("mailbox unavailable");
    expect(log.canUndo("c1")).toBe(true);
    await log.undo("c1");
    expect(attempts).toBe(2);
    expect((await log.list())[0]).toMatchObject({ undone: true });
  });

  it("survives a restart, and a half-written last line", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1")) log.record(e);
    log.record(finished("c1"));
    await log.list();
    await new Promise((r) => setTimeout(r, 30)); // the append is queued
    expect(readFileSync(join(dir, "activity.jsonl"), "utf8")).toContain('"id":"c1"');

    const fresh = new ActivityLog(dir);
    const entries = await fresh.list();
    expect(entries.map((e) => e.id)).toEqual(["c1"]);
    // Undo closures do not survive; the entry is history now.
    await expect(fresh.undo("c1")).rejects.toThrow();
  });

  it("clears the journal and undo handles", async () => {
    const log = new ActivityLog(dir);
    for (const e of call("c1")) log.record(e);
    log.offerUndo("c1", "Geri al", async () => {});
    log.record(finished("c1"));
    await log.clear();
    expect(await log.list()).toEqual([]);
    expect(await new ActivityLog(dir).list()).toEqual([]);
    await expect(log.undo("c1")).rejects.toThrow();
  });
});
