import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@ocak/agent-core";
import { setLocale } from "@ocak/i18n";
import { createShortcutTools, SHORTCUT_RUN, shortcutName, SHORTCUTS_LIST } from "../src/shortcuts.js";

const script = (template: string, input: unknown, app: unknown) =>
  JSON.parse(runInNewContext(`${template}\nrun([${JSON.stringify(JSON.stringify(input))}])`, { Application: () => app, JSON }));
const fn = <T>(value: T) => () => value;
const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

const library = (ran: unknown[] = []) => {
  const one = { run: (opts?: { withInput: string }) => { ran.push(opts?.withInput ?? null); return opts ? [`got ${opts.withInput}`] : undefined; } };
  return {
    shortcuts: Object.assign(
      {
        name: fn(["Vunemi Test", "Morning", "Share photo"]),
        subtitle: fn(["", "Weather and calendar", null]),
        actionCount: fn([2, 5, 3]),
        acceptsInput: fn([true, false, true]),
        folder: { name: fn([null, "Daily", null]) },
      },
      { whose: (q: { name: string }) => fn(q.name === "Vunemi Test" ? [one] : []) },
    ),
  };
};

describe("shortcut scripts", () => {
  it("lists name, steps, input and subtitle, filtered by a word", () => {
    const all = script(SHORTCUTS_LIST, { query: "", limit: 100 }, library());
    expect(all.total).toBe(3);
    expect(all.shortcuts[0]).toEqual({ name: "Vunemi Test", steps: 2, takesInput: true });
    expect(all.shortcuts[1]).toEqual({ name: "Morning", steps: 5, takesInput: false, subtitle: "Weather and calendar", folder: "Daily" });
    expect(script(SHORTCUTS_LIST, { query: "weather", limit: 100 }, library()).shortcuts.map((s: { name: string }) => s.name)).toEqual(["Morning"]);
    expect(script(SHORTCUTS_LIST, { query: "", limit: 1 }, library()).shortcuts).toHaveLength(1);
  });

  it("runs only the exact name, with input when given", () => {
    const ran: unknown[] = [];
    expect(script(SHORTCUT_RUN, { name: "Vunemi Test", input: "hi" }, library(ran))).toEqual({ found: true, result: ["got hi"] });
    expect(script(SHORTCUT_RUN, { name: "Vunemi Test" }, library(ran))).toEqual({ found: true, result: null });
    expect(script(SHORTCUT_RUN, { name: "tenami test" }, library(ran))).toEqual({ found: false });
    expect(ran).toEqual(["hi", null]);
  });
});

describe("shortcut tools", () => {
  afterEach(() => setLocale("en"));

  it("reads once per conversation, and asks before every run as an outbound action", () => {
    const [list, run] = createShortcutTools(vi.fn());
    expect(list!.actionClass).toBe("read");
    expect(list!.allowSessionApproval).toBe(true);
    expect(list!.untrustedOutput).toBe(true);
    expect(run!.actionClass).toBe("outbound");
    expect(run!.alwaysAsk).toBe(true);
    expect(run!.allowSessionApproval).toBeUndefined();
  });

  it("shows a listed shortcut's size and input on the card, and says Vunemi can't see inside", async () => {
    setLocale("en");
    const runner = vi.fn(async (): Promise<unknown> => ({ total: 1, shortcuts: [{ name: "Vunemi Test", steps: 2, takesInput: true }] }));
    const [list, run] = createShortcutTools(runner);
    expect(await run!.preview!({ name: "Vunemi Test" })).toContain("Run the shortcut “Vunemi Test” (no input)");
    await list!.run({}, ctx);
    const card = await run!.preview!({ name: "Vunemi Test", input: "hello" });
    expect(card).toContain("2 steps");
    expect(card).toContain("input: “hello”");
    expect(card).toContain("can't see its steps");
  });

  it("passes input only when there is some, and reports a missing shortcut", async () => {
    const runner = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ found: true, result: "done" }));
    const [, run] = createShortcutTools(runner);
    expect(await run!.run({ name: "Vunemi Test", input: "" }, ctx)).toBe('Ran "Vunemi Test". It returned:\ndone');
    expect(runner.mock.calls[0]![1]).toEqual({ app: "Shortcuts", name: "Vunemi Test" });
    await run!.run({ name: "Vunemi Test", input: "x" }, ctx);
    expect(runner.mock.calls[1]![1]).toEqual({ app: "Shortcuts", name: "Vunemi Test", input: "x" });
    runner.mockResolvedValueOnce({ found: false });
    expect(await run!.run({ name: "Nope" }, ctx)).toContain("no shortcut named");
    await expect(run!.run({ name: "Vunemi Test", input: "x".repeat(5001) }, ctx)).rejects.toThrow();
  });

  it("accepts one-line names only", () => {
    expect(shortcutName("  Vunemi Test ")).toBe("Vunemi Test");
    for (const bad of ["", "a\nb", "x".repeat(201), undefined]) expect(() => shortcutName(bad)).toThrow();
  });
});
