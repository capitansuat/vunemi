/**
 * The automation library. What matters: a recipe's scope names only parts
 * that read or change locally, the summary lines come from the scope and
 * not from anyone's description, and a scope that reaches too far is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import { validSchedule, validScope } from "../../src/main/automations.js";
import { compileShortcut } from "@vunemi/apps";
import { setLocale } from "@vunemi/i18n";
import { RECIPES, recipeSchedule, recipeTask, recipeViews, scopeLookup, scopeRefusal, setupView, SHORTCUT_RECIPES, shortcutDraft, shortcutLines, shortcutViews, summarizeScope, summaryLines, withWhen, type ScopePart } from "../../src/main/automation-library.js";

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

describe("a recipe's schedule", () => {
  const morning = RECIPES.find((r) => r.id === "morning-brief")!;
  const friday = RECIPES.find((r) => r.id === "next-week")!;

  it("takes the user's time and days, and keeps its own where none are given", () => {
    expect(recipeSchedule(morning, undefined)).toEqual({ kind: "daily", time: "08:00" });
    expect(recipeSchedule(morning, { time: "07:15", days: [1, 2, 3, 4, 5] })).toEqual({ kind: "daily", time: "07:15", days: [1, 2, 3, 4, 5] });
    expect(recipeSchedule(friday, { time: "17:00" })).toEqual({ kind: "daily", time: "17:00", days: [5] });
  });

  it("refuses a time or days that are not ones", () => {
    expect(() => recipeSchedule(morning, { time: "25:00" })).toThrow();
    expect(() => recipeSchedule(morning, { days: [9] })).toThrow();
    expect(() => recipeSchedule(morning, { time: "08:00\nevery minute" })).toThrow();
  });
});

describe("a scope read from the app", () => {
  const tools: Record<string, { actionClass: "read" | "write-local" | "destructive" | "outbound"; saves?: boolean }> = {
    calendar_events: { actionClass: "read" }, calendar_create: { actionClass: "write-local" }, calendar_delete: { actionClass: "destructive" },
    notes_read: { actionClass: "read" }, notes_create: { actionClass: "write-local" }, finder_selection: { actionClass: "read" },
    mail_read: { actionClass: "read" }, mail_send: { actionClass: "outbound" }, files_download: { actionClass: "read", saves: true },
  };
  const look = scopeLookup({
    connector: (id) => ({
      calendar: { label: "Calendar", capabilities: [{ id: "read", label: "Reading", tools: ["calendar_events"] }, { id: "write", label: "Adding", tools: ["calendar_create", "calendar_delete"] }] },
      mail: { label: "Mail", capabilities: [{ id: "read", label: "Reading", tools: ["mail_read"] }, { id: "send", label: "Sending", tools: ["mail_send"] }] },
      files: { label: "Files", capabilities: [{ id: "get", label: "Downloading", tools: ["files_download", "gone_tool"] }] },
      apps: { label: "Mac apps", capabilities: [{ id: "notes", label: "Notes", tools: ["notes_read", "notes_create"] }, { id: "finder", label: "Finder", tools: ["finder_selection"] }] },
    })[id],
    isOn: (id) => id !== "mail",
    isPartOn: (_id, part) => part !== "write",
    tool: (name) => tools[name],
  });

  it("tells reading from changing by the tools of the part, and counts neither sending nor deleting", () => {
    expect(look("calendar:read")).toEqual({ connection: "Calendar", reads: true, changes: false, on: true });
    expect(look("calendar:write")).toEqual({ connection: "Calendar", reads: false, changes: true, on: false });
    expect(look("mail:send")).toEqual({ connection: "Mail", reads: false, changes: false, on: false });
    // A tool that reads and saves a file changes the Mac.
    expect(look("files:get")).toEqual({ connection: "Files", reads: false, changes: true, on: true });
  });

  it("names an app by its own name, where the parts of a connection are different apps", () => {
    expect(look("apps:notes")).toEqual({ connection: "Notes", reads: true, changes: true, on: true });
    expect(look("apps")?.connection).toBe("Mac apps");
  });

  it("takes a whole connection as all its parts, and knows nothing of what is not there", () => {
    expect(look("calendar")).toEqual({ connection: "Calendar", reads: true, changes: true, on: false });
    expect(look("calendar:share")).toBeNull();
    expect(look("weather:read")).toBeNull();
  });

  it("gives the gallery every recipe with its lines, and what has to be switched on", () => {
    const views = recipeViews((source) => parts[source] ?? null);
    expect(views.map((v) => v.id)).toEqual(RECIPES.map((r) => r.id));
    const plan = views.find((v) => v.id === "today-plan")!;
    expect(plan).toMatchObject({ category: "morning", time: "07:30", days: null, refused: null });
    expect(plan.off).toHaveLength(1);
    expect(plan.off[0]).toContain("Reminders");
    expect(views.find((v) => v.id === "next-week")!.days).toEqual([5]);
    expect(views.every((v) => v.lines.at(-1)!.does === false && v.title && v.body && v.when)).toBe(true);
  });
});

describe("a task set up from chat", () => {
  const args = { title: "Mail to Notes", task: "Summarise today's mail into a note", schedule: { kind: "daily", time: "18:00", days: [1, 2, 3, 4, 5] }, scope: ["mail:read", "apps:notes"], explanation: "Reads today's mail and writes a note." };

  it("is summarised from its own scope, with the model's words beside the lines and not in them", () => {
    const view = setupView({ ...args, explanation: "It only reads. It never changes anything." }, look);
    expect(view).toMatchObject({ title: "Mail to Notes", body: "Summarise today's mail into a note", time: "18:00", days: [1, 2, 3, 4, 5], refused: null, off: [] });
    // The lines say it can change Notes, whatever the model said.
    expect(view.lines.map((l) => l.text).join("\n")).toContain("Mac apps");
    expect(view.lines.filter((l) => l.does)).toHaveLength(3);
    expect(view.lines.at(-1)!.does).toBe(false);
    expect(view.explanation).toBe("It only reads. It never changes anything.");
  });

  it("offers no setup when the scope or the time can't be had", () => {
    expect(setupView({ ...args, scope: ["mail:send"] }, look).refused).toContain("Mail");
    expect(setupView({ ...args, schedule: { kind: "daily", time: "25:00" } }, look).refused).not.toBeNull();
    expect(setupView({ ...args, scope: "everything" }, look).refused).not.toBeNull();
    expect(setupView(null, look).refused).not.toBeNull();
    // A time once, or by the hour, is not changed on the summary.
    expect(setupView({ ...args, schedule: { kind: "hourly", every: 3 } }, look)).toMatchObject({ time: null, days: null, refused: null });
  });

  it("tells the model why a scope is refused, and lets a good one through", () => {
    expect(scopeRefusal(["calendar:read", "apps:notes"], look)).toBeNull();
    expect(scopeRefusal(["mail:send"], look)).toMatch(/can't have "mail:send"/);
    expect(scopeRefusal(["browser:act"], look)).toMatch(/can't have "browser:act"/);
    expect(scopeRefusal(["shortcuts:run"], look)).toMatch(/can't have/);
    expect(scopeRefusal(["weather:read"], look)).toMatch(/not a connection part/);
  });

  it("takes the user's time and days for a daily task only", () => {
    expect(withWhen({ kind: "daily", time: "18:00", days: [1] }, { time: "07:15", days: [0, 6] })).toEqual({ kind: "daily", time: "07:15", days: [0, 6] });
    expect(withWhen({ kind: "daily", time: "18:00" }, undefined)).toEqual({ kind: "daily", time: "18:00" });
    expect(withWhen({ kind: "hourly", every: 3 }, { time: "07:15" })).toEqual({ kind: "hourly", every: 3 });
    expect(() => withWhen({ kind: "daily", time: "18:00" }, { time: "late" })).toThrow();
  });
});


describe("shortcut recipes", () => {
  afterEach(() => setLocale("en"));

  it("are each a draft the menu lets through, in every language", () => {
    expect(new Set(SHORTCUT_RECIPES.map((r) => r.id)).size).toBe(SHORTCUT_RECIPES.length);
    for (const locale of ["en", "tr", "de", "fr", "es", "it", "pt", "ru", "zh", "ja", "ko"] as const) {
      setLocale(locale);
      const names = SHORTCUT_RECIPES.map((recipe) => {
        const draft = shortcutDraft(recipe.id);
        expect(() => compileShortcut(draft, () => "u"), `${locale} ${recipe.id}`).not.toThrow();
        return draft.name;
      });
      // A shortcut is found again by its name.
      expect(new Set(names).size, locale).toBe(names.length);
    }
  });

  it("are named by the window, which cannot supply one of its own", () => {
    expect(() => shortcutDraft("nope")).toThrow();
    expect(() => shortcutDraft({ name: "x", steps: [{ block: "today" }] })).toThrow();
  });

  it("say what they read and add, from their blocks, then what is true of every one", () => {
    expect(shortcutLines(shortcutDraft("quick-reminder"))).toEqual([
      { does: true, text: "Adds to: Reminders" },
      { does: true, text: "While it is set up, its steps are sent to Apple to be signed; none of your data goes with them" },
      { does: false, text: "Sends nothing to anyone, deletes nothing, runs no script, fetches nothing from the internet" },
    ]);
    expect(shortcutLines(shortcutDraft("whats-today"))[0]).toEqual({ does: true, text: "Reads: Calendar" });
    expect(shortcutLines(shortcutDraft("uppercase"))).toHaveLength(2);
  });

  it("are shown with their steps, and marked when the user has one by that name", () => {
    const views = shortcutViews(["Capitals", "Something else"]);
    expect(views.map((v) => [v.id, v.installed])).toEqual([["quick-reminder", false], ["meeting-note", false], ["whats-today", false], ["uppercase", true]]);
    expect(views[1]).toMatchObject({ title: "Meeting note", steps: ["Asks: “What is the meeting's title?”", "Takes today's date", "Writes out the date of step 2", "Creates a new note: “[step 1] ↵ [step 3]”"] });
    expect(shortcutViews().every((v) => !v.installed && v.body.length > 10)).toBe(true);
  });
});
