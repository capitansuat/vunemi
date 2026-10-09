/**
 * The automation library. What matters: a recipe's scope names only parts
 * that read or change locally, the summary lines come from the scope and
 * not from anyone's description, and a scope that reaches too far is refused.
 */
import { describe, expect, it } from "vitest";
import { validSchedule, validScope } from "../../src/main/automations.js";
import { RECIPES, recipeTask, summarizeScope, summaryLines, type ScopePart } from "../../src/main/automation-library.js";

/** The parts as the app would describe them, all switched on unless named. */
const parts: Record<string, ScopePart> = {
  "calendar:read": { connection: "Calendar", reads: true, changes: false, on: true },
  "mail:read": { connection: "Mail", reads: true, changes: false, on: true },
  // Its only tool sends: a scheduled run gets none of it.
  "mail:send": { connection: "Mail", reads: false, changes: false, on: true },
  "reminders:read": { connection: "Reminders", reads: true, changes: false, on: false },
  "apps:notes": { connection: "Mac apps", reads: true, changes: true, on: true },
  "files:read": { connection: "Files", reads: true, changes: false, on: true },
  "files:write": { connection: "Files", reads: false, changes: true, on: false },
  "browser:read": { connection: "Browser", reads: true, changes: false, on: true },
  "browser:act": { connection: "Browser", reads: false, changes: true, on: true },
  "shortcuts:run": { connection: "Shortcuts", reads: true, changes: true, on: true },
};
const look = (source: string): ScopePart | null => parts[source] ?? null;

describe("recipes", () => {
  it("each have a valid schedule, a valid scope the summary accepts, and their texts", () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const recipe of RECIPES) {
      expect(validSchedule(recipe.schedule), recipe.id).toEqual(recipe.schedule);
      expect(validScope([...recipe.scope]), recipe.id).toEqual([...recipe.scope]);
      expect(summarizeScope(recipe.scope, look).refused, recipe.id).toBeNull();
      const made = recipeTask(recipe.id);
      expect(made.title.length, recipe.id).toBeGreaterThan(0);
      expect(made.task.length, recipe.id).toBeGreaterThan(20);
      expect(made.scope).toEqual([...recipe.scope]);
    }
  });

  it("are named by the window, which cannot supply one of its own", () => {
    expect(() => recipeTask("send-everything")).toThrow();
    expect(() => recipeTask("__proto__")).toThrow();
  });

  it("only read where their line says they only read", () => {
    const changing = RECIPES.filter((r) => summarizeScope(r.scope, look).changes.length > 0).map((r) => r.id);
    expect(changing).toEqual(["mail-to-notes", "sort-downloads"]);
  });
});

describe("the summary of a scope", () => {
  it("says what is read and what can change, each connection once, and which are switched off", () => {
    expect(summarizeScope(["calendar:read", "mail:read", "apps:notes", "files:read", "files:write", "reminders:read"], look)).toEqual({
      reads: ["Calendar", "Mail", "Mac apps", "Files", "Reminders"],
      changes: ["Mac apps", "Files"],
      off: ["Files", "Reminders"],
      refused: null,
    });
  });

  it("refuses a part nobody knows, one whose tools a scheduled run never gets, and the ones that reach anything", () => {
    expect(summarizeScope(["calendar:read", "weather:read"], look).refused).toMatch(/weather:read/);
    for (const source of ["mail:send", "browser:act", "shortcuts:run", "automations:create", "desktop:act"]) {
      const withIt = { ...parts, "automations:create": { connection: "Scheduled tasks", reads: true, changes: true, on: true }, "desktop:act": { connection: "Desktop", reads: false, changes: true, on: true } };
      expect(summarizeScope(["calendar:read", source], (s) => withIt[s as keyof typeof withIt] ?? null).refused, source).not.toBeNull();
    }
    // Reading the web is fine: with no way to send, nothing read can leave.
    expect(summarizeScope(["browser:read"], look).refused).toBeNull();
  });

  it("is written from the scope: what it does, then what no scheduled task does", () => {
    const lines = summaryLines(summarizeScope(["calendar:read", "apps:notes"], look));
    expect(lines.map((l) => l.does)).toEqual([true, true, true, false]);
    expect(lines[0]!.text).toContain("Calendar, Mac apps");
    expect(lines[1]!.text).toContain("Mac apps");
    expect(lines[1]!.text).not.toContain("Calendar");
    const readOnly = summaryLines(summarizeScope(["mail:read"], look));
    expect(readOnly.map((l) => l.does)).toEqual([true, true, false]);
  });
});
