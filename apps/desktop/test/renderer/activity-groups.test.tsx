import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "@vunemi/i18n";
import type { ActivityEntry } from "../../src/shared/ipc.js";
import { groupByTask, matchesActivity } from "../../src/renderer/src/lib/activity-groups.js";

const shown = vi.hoisted(() => ({ activity: [] as ActivityEntry[] }));
vi.hoisted(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} }));
vi.mock("../../src/renderer/src/store.js", () => ({ useStore: () => ({ activity: shown.activity, setActivity: () => {} }) }));

const entry = (id: string, runId: string, at: number, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id, runId, at, goal: `Goal ${runId}`, tool: "files_read", actionClass: "read", status: "ok", ...extra,
});

describe("activity tasks", () => {
  it("gathers a task's rows under its request, newest task first, and counts what can be undone", () => {
    const tasks = groupByTask([
      entry("c", "r2", 300, { undo: "Put B3 back", actionClass: "write-local" }),
      entry("b", "r2", 250, { status: "error" }),
      entry("a", "r1", 100, { undo: "Restore", undone: true }),
    ]);
    expect(tasks.map((task) => [task.runId, task.entries.map((e) => e.id), task.since, task.at, task.undoable, task.problems])).toEqual([
      ["r2", ["c", "b"], 250, 300, 1, 1],
      ["r1", ["a"], 100, 100, 0, 0],
    ]);
  });

  it("marks a task that is still running", () => {
    expect(groupByTask([entry("a", "r", 1, { status: "waiting-user" })])[0]!.active).toBe(true);
  });

  it("finds a row by its request, what it did or its label, without minding case or Turkish letters", () => {
    const row = entry("a", "r", 1, { goal: "Şubat satışlarını düzelt", preview: "Run Satislar!B3:B3 (~/Desktop/rapor.xlsx)", tool: "excel_write_range" });
    for (const query of ["subat", "ŞUBAT", "rapor.xlsx", "excel_write", "Wrote cells", "satis b3"]) {
      expect(matchesActivity(row, query, "Wrote cells")).toBe(true);
    }
    expect(matchesActivity(row, "mart", "Wrote cells")).toBe(false);
    expect(matchesActivity(row, "subat mart", "Wrote cells")).toBe(false);
    expect(matchesActivity(row, "  ", "Wrote cells")).toBe(true);
  });
});

describe("the activity log screen", () => {
  it("opens with each task closed, showing its request, how many rows and how many can be undone", async () => {
    setLocale("en");
    const { ActivityView } = await import("../../src/renderer/src/components/ActivityView.js");
    const now = Date.now();
    shown.activity = [
      entry("w", "edit", now, { goal: "Change B3 in rapor.xlsx", tool: "excel_write_range", actionClass: "write-local", preview: "Run Satislar!B3:B3", undo: "Put B3 back" }),
        entry("r", "edit", now - 1000, { goal: "Change B3 in rapor.xlsx", preview: "Read Excel" }),
        entry("x", "older", now - 5000, { goal: "Read the report" }),
    ];
    const html = renderToStaticMarkup(<ActivityView />);
    expect(html).toContain("Change B3 in rapor.xlsx");
    expect(html).toContain("Read the report");
    expect(html).toContain(t("activity.actions", { count: 2 }));
    expect(html).toContain(t("activity.undoable", { count: 1 }));
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).not.toContain("Run Satislar!B3:B3");
    expect(html).toContain(t("activity.search"));
  });

  it("keeps a running task open, so what it is doing stays in view", async () => {
    setLocale("en");
    const { ActivityView } = await import("../../src/renderer/src/components/ActivityView.js");
    shown.activity = [entry("w", "live", Date.now(), { status: "waiting-user", preview: "Run Satislar!B3:B3" })];
    const html = renderToStaticMarkup(<ActivityView />);
    expect(html).toContain(`aria-expanded="true"`);
    expect(html).toContain("Run Satislar!B3:B3");
  });
});
