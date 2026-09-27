import { describe, expect, it } from "vitest";
import { RECORDS, TASK_CASES, routeHint, scoreTask, validateFixtures } from "../../../scripts/task-routing-fixtures.js";

describe("routing benchmark fixture", () => {
  it("has balanced, unique English and Turkish tasks whose answers are only in the synthetic records", () => {
    expect(() => validateFixtures()).not.toThrow();
    expect(TASK_CASES).toHaveLength(16);
    for (const kind of ["chat", "web", "files", "apps"] as const) {
      const rows = TASK_CASES.filter((task) => task.kind === kind);
      expect(rows).toHaveLength(4);
      expect(rows.filter((task) => task.locale === "en")).toHaveLength(2);
      expect(rows.filter((task) => task.locale === "tr")).toHaveLength(2);
      for (const task of rows) {
        expect(task.goal).not.toContain(task.expectedAnswer);
        if (kind !== "chat") {
          expect(Object.values(RECORDS[kind]).some((text) => text.includes(task.expectedAnswer))).toBe(true);
        }
      }
    }
  });

  it("does not award a success for guessing, the wrong tool, extra tool calls or a failed run", () => {
    const task = TASK_CASES.find((item) => item.kind === "web")!;
    expect(scoreTask(task, ["web_read"], `The code is ${task.expectedAnswer}.`, "done").success).toBe(true);
    expect(scoreTask(task, [], `The code is ${task.expectedAnswer}.`, "done").success).toBe(false);
    expect(scoreTask(task, ["files_read"], `The code is ${task.expectedAnswer}.`, "done").success).toBe(false);
    expect(scoreTask(task, ["web_read", "files_read"], `The code is ${task.expectedAnswer}.`, "done").success).toBe(false);
    expect(scoreTask(task, ["web_read"], "I cannot find it.", "done").success).toBe(false);
    expect(scoreTask(task, ["web_read"], `The code is ${task.expectedAnswer}.`, "failed").success).toBe(false);
  });

  it("keeps routing advice separate from permission changes", () => {
    for (const kind of ["chat", "web", "files", "apps"] as const) {
      expect(routeHint(kind)).toContain("does not grant permission");
    }
  });
});
