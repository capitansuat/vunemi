import { describe, expect, it } from "vitest";
import { available, GOALS, IDEAS, PROJECT_GOALS, PROJECT_IDEAS, switchable } from "../../src/renderer/src/lib/suggestions.js";

describe("empty chat suggestions", () => {
  it("offers only what a ready connection can do", () => {
    const keys = available(IDEAS, new Set(["calendar"])).map((item) => item.key);
    expect(keys).toEqual(["app.ideas.today", "app.ideas.help"]);
    expect(available(GOALS, new Set(["calendar", "files"])).map((item) => item.key))
      .toEqual(["app.goals.calendar", "app.goals.week", "app.goals.files"]);
  });

  it("before the connections are known, offers only what needs none", () => {
    expect(available(IDEAS, null).map((item) => item.key)).toEqual(["app.ideas.help"]);
    expect(available(GOALS, null)).toEqual([]);
  });

  it("never offers the notepad", () => {
    expect([...GOALS, ...IDEAS].some((item) => /notepad|note/i.test(item.key))).toBe(false);
  });

  it("shows at most four of each", () => {
    const all = new Set(["mail", "calendar", "reminders", "files", "browser"]);
    expect(available(IDEAS, all)).toHaveLength(4);
    expect(available(GOALS, all)).toHaveLength(4);
  });

  it("in a project, offers work on its folder once Files is on", () => {
    expect(available(PROJECT_GOALS, new Set(["files"])).map((item) => item.key)).toContain("app.goals.projectWebsite");
    expect(available(PROJECT_IDEAS, new Set()).map((item) => item.key)).toEqual(["app.ideas.help"]);
  });

  it("offers to switch on what is off, three at most, and nothing before the list is known", () => {
    expect(switchable(null)).toEqual([]);
    expect(switchable(new Set()).map((item) => item.id)).toEqual(["calendar", "mail", "files"]);
    expect(switchable(new Set(["calendar", "mail"])).map((item) => item.id)).toEqual(["files", "browser", "reminders"]);
    expect(switchable(new Set(["calendar", "mail", "files", "browser", "reminders"]))).toEqual([]);
  });
});
